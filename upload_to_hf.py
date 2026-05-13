"""
Upload fine-tuned x-spam-classifier model to Hugging Face Hub.

Usage:
    HF_TOKEN=hf_xxx python upload_to_hf.py --repo chuccp/x-spam-classifier --input <model_dir>

The model directory must contain:
    config.json, tokenizer.json, tokenizer_config.json, vocab.txt
    model.safetensors (PyTorch weights)
    metrics.json (optional)
    onnx/model.onnx (ONNX model)

Progress lines (for Electron UI parsing):
    [STATUS] <message>
"""

import argparse
import json
import os
import sys


def status(msg):
    print(f"[STATUS] {msg}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Upload trained model to Hugging Face Hub")
    parser.add_argument("--repo", required=True, help="HF Hub repo ID (e.g. chuccp/x-spam-classifier)")
    parser.add_argument("--input", help="Model directory path (default: data/models/x-spam-classifier)")
    parser.add_argument("--token", help="HF token (or set HF_TOKEN env var)")
    args = parser.parse_args()

    token = args.token or os.environ.get("HF_TOKEN")
    if not token:
        status("ERROR: No HF token. Set HF_TOKEN env var or use --token")
        sys.exit(1)

    # Default input path: data/models/x-spam-classifier relative to script dir
    script_dir = os.path.dirname(os.path.abspath(__file__))
    input_dir = args.input or os.path.join(script_dir, "data", "models", "x-spam-classifier")

    if not os.path.isdir(input_dir):
        status(f"ERROR: Model directory not found: {input_dir}")
        status("Run train.py first to produce a trained model.")
        sys.exit(1)

    # Validate required files
    required = ["config.json", "tokenizer.json"]
    missing = [f for f in required if not os.path.exists(os.path.join(input_dir, f))]
    if missing:
        status(f"ERROR: Missing required files: {', '.join(missing)}")
        sys.exit(1)

    has_onnx = os.path.exists(os.path.join(input_dir, "onnx", "model.onnx"))
    has_safetensors = os.path.exists(os.path.join(input_dir, "model.safetensors"))
    if not has_onnx and not has_safetensors:
        status("ERROR: No model weights found (model.safetensors or onnx/model.onnx)")
        sys.exit(1)

    status(f"Model directory: {input_dir}")

    # List files to upload
    files_to_upload = []
    for root, dirs, files in os.walk(input_dir):
        # Skip .cache directories
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for f in files:
            if f.startswith("."):
                continue
            full = os.path.join(root, f)
            rel = os.path.relpath(full, input_dir).replace("\\", "/")
            files_to_upload.append((full, rel))

    status(f"Files to upload: {len(files_to_upload)}")
    for _, rel in files_to_upload:
        status(f"  {rel}")

    from huggingface_hub import HfApi, create_repo

    api = HfApi(token=token)

    # Create repo if not exists
    try:
        create_repo(args.repo, token=token, exist_ok=True)
        status(f"Repo ready: {args.repo}")
    except Exception as e:
        status(f"ERROR creating repo: {e}")
        sys.exit(1)

    # Upload each file
    for full_path, rel_path in files_to_upload:
        status(f"Uploading {rel_path} ...")
        try:
            api.upload_file(
                path_or_fileobj=full_path,
                path_in_repo=rel_path,
                repo_id=args.repo,
                token=token,
            )
        except Exception as e:
            status(f"ERROR uploading {rel_path}: {e}")
            sys.exit(1)

    status(f"Upload complete! Model is at https://huggingface.co/{args.repo}")


if __name__ == "__main__":
    main()
