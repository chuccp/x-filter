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

const emoji = require('node-emoji');

async function predict(text, postText) {
  if (!modelLoaded || !pipeline) {
    throw new Error(t('model.not_loaded'));
  }
  // @xenova/transformers pipeline only accepts strings / string arrays.
  // It does NOT support {text, text_pair} objects or [post, comment] array pairs.
  // We concatenate post + comment with a space to approximate dual-segment input.
  const commentClean = emoji.unemojify(text);
  const postClean = postText ? emoji.unemojify(postText) : '';
  const inputText = postClean ? `${postClean} ${commentClean}` : commentClean;
  const result = await pipeline(inputText);
  const top = result[0];
  const spam = top.label === 'spam';
  const confidence = top.score;
  return { spam, confidence };
}

async function predictBatch(items) {
  if (!modelLoaded || !pipeline) {
    throw new Error(t('model.not_loaded'));
  }

  // Build string inputs for batch inference
  const inputs = items.map(item => {
    const text = typeof item === 'string' ? item : item.text;
    const postText = typeof item === 'string' ? null : item.post_text;
    const commentClean = emoji.unemojify(text);
    const postClean = postText ? emoji.unemojify(postText) : '';
    return postClean ? `${postClean} ${commentClean}` : commentClean;
  });

  try {
    const results = await pipeline(inputs);
    return results.map(r => {
      const top = Array.isArray(r) ? r[0] : r;
      return {
        spam: top.label === 'spam',
        confidence: top.score,
      };
    });
  } catch (e) {
    // Fallback to sequential if batch inference fails
    const results = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const text = typeof items[i] === 'string' ? items[i] : items[i].text;
        const postText = typeof items[i] === 'string' ? null : items[i].post_text;
        results.push(await predict(text, postText));
      } catch (err) {
        results.push({ spam: false, confidence: 0, error: err.message });
      }
    }
    return results;
  }
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
