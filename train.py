"""
Train a BERT spam classifier for x-filter.

Usage:
    python train.py --csv data/labeled.csv --output data/models/x-spam-classifier

    CSV format: text,post_text,label
    post_text is optional — when present, it's concatenated as [POST] <post> [COMMENT] <comment>

Progress lines (for Electron UI parsing):
    [STATUS] <message>
    [PROGRESS] {"epoch": 1, "total": 5, "loss": 0.42}
    [METRICS] {"eval_f1": 0.89, "eval_accuracy": 0.92, ...}
"""

import argparse
import json
import os
import sys
import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.metrics import f1_score, precision_score, recall_score
from sklearn.utils.class_weight import compute_class_weight
import emoji
import torch
import torch.nn as nn
from transformers import (
    AutoTokenizer,
    AutoModelForSequenceClassification,
    TrainingArguments,
    Trainer,
    EarlyStoppingCallback,
    TrainerCallback,
)
from optimum.onnxruntime import ORTModelForSequenceClassification


def status(msg):
    print(f"[STATUS] {msg}", flush=True)


def progress(epoch, total, loss=None):
    d = {"epoch": epoch, "total": total}
    if loss is not None:
        d["loss"] = loss
    print(f"[PROGRESS] {json.dumps(d)}", flush=True)


def save_metrics(metrics_dict):
    print(f"[METRICS] {json.dumps(metrics_dict)}", flush=True)


class ProgressCallback(TrainerCallback):
    def __init__(self, total_epochs):
        self.total_epochs = total_epochs

    def on_log(self, args, state, control, logs=None, **kwargs):
        if logs and "loss" in logs:
            epoch = int(state.epoch or 0) + 1
            progress(epoch, self.total_epochs, loss=logs.get("loss", None))

    def on_epoch_end(self, args, state, control, **kwargs):
        status(f"Epoch {int(state.epoch)} completed")


def parse_args():
    p = argparse.ArgumentParser(description="Train x-filter spam classifier")
    p.add_argument("--csv", required=True, help="Path to labeled CSV file")
    p.add_argument("--output", default="data/models/x-spam-classifier", help="Output model path")
    p.add_argument("--model", default="bert-base-multilingual-cased", help="Base model name")
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=16)
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--max-len", type=int, default=512, help="Max token length (BERT limit)")
    p.add_argument("--test-size", type=float, default=0.2)
    p.add_argument("--gradient-accumulation-steps", type=int, default=1, help="Gradient accumulation steps")
    return p.parse_args()


def load_data(csv_path):
    df = pd.read_csv(csv_path)
    # Use BERT dual-segment input: post_text as segment A, comment as segment B.
    # This lets the model use token_type_ids to distinguish the two parts,
    # leveraging the pre-trained next-sentence-prediction knowledge.
    has_post = "post_text" in df.columns
    if has_post:
        post_texts = (
            df["post_text"]
            .fillna("")
            .astype(str)
            .str.strip()
            .apply(lambda x: emoji.demojize(x) if x else "")
            .tolist()
        )
    else:
        post_texts = [""] * len(df)
    comment_texts = df["text"].astype(str).apply(emoji.demojize).tolist()
    labels = df["label"].astype(int).tolist()
    return train_test_split(
        post_texts, comment_texts, labels,
        test_size=args.test_size, random_state=42, stratify=labels
    )


class SpamDataset(torch.utils.data.Dataset):
    def __init__(self, encodings, labels):
        self.encodings = encodings
        self.labels = labels

    def __getitem__(self, idx):
        item = {k: torch.tensor(v[idx]) for k, v in self.encodings.items()}
        item["labels"] = torch.tensor(self.labels[idx])
        return item

    def __len__(self):
        return len(self.labels)


class WeightedTrainer(Trainer):
    """Trainer with class-balanced loss to handle imbalanced spam/not-spam data."""

    def __init__(self, class_weights, label_smoothing=0.0, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.class_weights = class_weights
        self.label_smoothing = label_smoothing

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        loss_fct = nn.CrossEntropyLoss(
            weight=self.class_weights.to(model.device),
            label_smoothing=self.label_smoothing
        )
        loss = loss_fct(outputs.logits, labels)
        return (loss, outputs) if return_outputs else loss


def compute_metrics(pred):
    labels = pred.label_ids
    preds = pred.predictions.argmax(-1)
    f1 = f1_score(labels, preds)
    precision = precision_score(labels, preds)
    recall = recall_score(labels, preds)
    return {"f1": f1, "precision": precision, "recall": recall, "accuracy": (preds == labels).mean()}


def main():
    global args
    args = parse_args()

    status(f"Loading data from {args.csv}...")
    train_posts, val_posts, train_comments, val_comments, train_labels, val_labels = load_data(args.csv)
    status(f"Data loaded: {len(train_labels)} train + {len(val_labels)} val samples")
    status(f"Spam: {sum(train_labels)}, Not spam: {len(train_labels) - sum(train_labels)}")

    # Compute class weights for imbalanced data
    class_weights = compute_class_weight(
        'balanced', classes=np.unique(train_labels), y=train_labels
    )
    class_weights = torch.tensor(class_weights, dtype=torch.float)
    status(f"Class weights: spam={class_weights[1]:.2f}, not_spam={class_weights[0]:.2f}")

    status("Loading tokenizer and model...")
    model_source = args.model
    if os.path.exists(os.path.join(args.model, 'config.json')):
        status(f"Using local pretrained model: {args.model}")
    else:
        status(f"Downloading model from HuggingFace Hub: {args.model}")

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    status(f"Device: {device}" + (f" (GPU: {torch.cuda.get_device_name(0)})" if device == 'cuda' else ' (no CUDA available, training will be slow)'))

    tokenizer = AutoTokenizer.from_pretrained(model_source)
    model = AutoModelForSequenceClassification.from_pretrained(model_source, num_labels=2)

    status("Tokenizing (dual-segment: post as segment A, comment as segment B)...")
    train_encodings = tokenizer(
        train_posts, train_comments,
        truncation=True, padding=True, max_length=args.max_len
    )
    val_encodings = tokenizer(
        val_posts, val_comments,
        truncation=True, padding=True, max_length=args.max_len
    )

    train_dataset = SpamDataset(train_encodings, train_labels)
    val_dataset = SpamDataset(val_encodings, val_labels)

    training_args = TrainingArguments(
        output_dir="./checkpoints",
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.gradient_accumulation_steps,
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=5,
        logging_steps=10,
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        learning_rate=args.lr,
        weight_decay=0.01,
        warmup_ratio=0.1,
        label_smoothing_factor=0.1,
        fp16=device == 'cuda',
        report_to="none",
        dataloader_pin_memory=(device == 'cuda'),
        dataloader_num_workers=2 if device == 'cuda' else 0,
    )

    trainer = WeightedTrainer(
        class_weights=class_weights,
        label_smoothing=training_args.label_smoothing_factor,
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        compute_metrics=compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=3), ProgressCallback(args.epochs)],
    )

    status(f"Starting training: {args.epochs} epochs...")
    trainer.train()

    status("Evaluating...")
    results = trainer.evaluate()
    metrics = {k: float(v) for k, v in results.items()}
    save_metrics(metrics)

    status("Saving model...")
    os.makedirs(args.output, exist_ok=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)

    status("Exporting ONNX...")
    onnx_dir = os.path.join(args.output, "onnx")
    os.makedirs(onnx_dir, exist_ok=True)
    ort_model = ORTModelForSequenceClassification.from_pretrained(args.output, export=True)
    ort_model.save_pretrained(onnx_dir)
    tokenizer.save_pretrained(onnx_dir)

    # Add id2label/label2id to config for transformers.js inference
    for subdir in [args.output, onnx_dir]:
        cfg_path = os.path.join(subdir, 'config.json')
        if os.path.exists(cfg_path):
            with open(cfg_path, 'r') as f:
                cfg = json.load(f)
            cfg['id2label'] = {'0': 'not_spam', '1': 'spam'}
            cfg['label2id'] = {'not_spam': 0, 'spam': 1}
            cfg['num_labels'] = 2
            with open(cfg_path, 'w') as f:
                json.dump(cfg, f, indent=2)

    metrics_path = os.path.join(args.output, "metrics.json")
    with open(metrics_path, "w") as f:
        json.dump(metrics, f, indent=2)

    status(f"Training complete! Model saved to {args.output}")


if __name__ == "__main__":
    main()
