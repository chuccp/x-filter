/**
 * Model Manager — inference only.
 * Loads a fine-tuned ONNX BERT model exported by train.py.
 * Uses @xenova/transformers for Node.js inference.
 */
const path = require('path');
const { app } = require('electron');
const { t } = require('./i18n');

let pipeline = null;
let modelLoaded = false;
let modelStatus = { loaded: false, error: null, metrics: null };

async function loadModel(modelPath) {
  const { pipeline: transformersPipeline, env } = require('@xenova/transformers');

  const modelDir = modelPath || path.join(app.getPath('userData'), 'models', 'x-spam-classifier');
  const onnxDir = path.join(modelDir, 'onnx');

  const fs = require('fs');

  // Use the model root directory (not onnx/ subdirectory).
  // @xenova/transformers expects: <model_root>/onnx/model.onnx
  let loadPath = modelDir;

  if (!fs.existsSync(path.join(loadPath, 'config.json'))) {
    modelStatus = { loaded: false, error: t('model.not_found', { path: modelDir }) };
    return modelStatus;
  }

  // Work around @xenova/transformers pathJoin bug on Windows:
  // The library's custom pathJoin doesn't handle absolute Windows paths,
  // so we set localModelPath to the parent directory and use only the leaf name.
  const parentDir = path.dirname(loadPath);
  const modelName = path.basename(loadPath);

  env.localModelPath = parentDir;
  env.allowRemoteModels = false;

  try {
    pipeline = await transformersPipeline('text-classification', modelName, { quantized: false });
    modelLoaded = true;

    // Load metrics if available
    const metricsPath = path.join(modelDir, 'metrics.json');
    let metrics = null;
    if (fs.existsSync(metricsPath)) {
      metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
    }

    modelStatus = { loaded: true, error: null, metrics, path: loadPath };
    return modelStatus;
  } catch (e) {
    modelStatus = { loaded: false, error: e.message };
    return modelStatus;
  }
}

/**
 * Build the input text for the classifier.
 * When post_text is available, concatenate with comment to assess relevance.
 */
const emoji = require('node-emoji');

function buildInput(text, postText) {
  if (postText) {
    return `[POST] ${emoji.demojify(postText)} [COMMENT] ${emoji.demojify(text)}`;
  }
  return emoji.demojify(text);
}

async function predict(text, postText) {
  if (!modelLoaded || !pipeline) {
    throw new Error(t('model.not_loaded'));
  }
  const input = buildInput(text, postText);
  const result = await pipeline(input);
  // result looks like: [{ label: 'LABEL_0', score: 0.95 }]
  // LABEL_1 = spam, LABEL_0 = not-spam
  const top = result[0];
  const spam = top.label === 'LABEL_1';
  const confidence = top.score;
  return { spam, confidence };
}

async function predictBatch(items) {
  if (!modelLoaded || !pipeline) {
    throw new Error(t('model.not_loaded'));
  }
  const results = [];
  for (const item of items) {
    try {
      // item can be a string or {text, post_text} object
      const text = typeof item === 'string' ? item : item.text;
      const postText = typeof item === 'string' ? null : item.post_text;
      const r = await predict(text, postText);
      results.push(r);
    } catch (e) {
      results.push({ spam: false, confidence: 0, error: e.message });
    }
  }
  return results;
}

function getStatus() {
  return modelStatus;
}

module.exports = {
  loadModel,
  predict,
  predictBatch,
  getStatus,
};
