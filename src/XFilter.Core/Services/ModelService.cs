using System.Text.Json;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using XFilter.Core.Models;
using XFilter.Core.Tokenization;

namespace XFilter.Core.Services;

public interface IModelService
{
    ModelStatus GetStatus();
    Task<ModelStatus> LoadModelAsync(string? modelPath = null);
    Task<PredictionResult> PredictAsync(string text, string? postText = null);
    Task<List<PredictionResult>> PredictBatchAsync(List<CommentInput> items);
}

public class CommentInput
{
    public string Text { get; set; } = "";
    public string? PostText { get; set; }
}

public class ModelService : IModelService, IDisposable
{
    private InferenceSession? _session;
    private BertTokenizer? _tokenizer;
    private ModelStatus _status = new() { Loaded = false };

    public ModelStatus GetStatus() => _status;

    public async Task<ModelStatus> LoadModelAsync(string? modelPath = null)
    {
        try
        {
            var modelDir = modelPath ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "x-filter", "models", "x-spam-classifier");

            var onnxPath = Path.Combine(modelDir, "onnx", "model.onnx");
            if (!File.Exists(onnxPath))
                onnxPath = Path.Combine(modelDir, "model.onnx");

            if (!File.Exists(onnxPath))
            {
                _status = new ModelStatus { Loaded = false, Error = $"Model not found at {modelDir}" };
                return _status;
            }

            _tokenizer?.GetType(); // no-op, C# tokenizer doesn't need dispose
            _session?.Dispose();

            var sessionOptions = new SessionOptions();
            // CPU only by default — CUDA can be added later
            _session = new InferenceSession(onnxPath, sessionOptions);
            _tokenizer = new BertTokenizer(modelDir);

            // Load metrics
            var metricsPath = Path.Combine(modelDir, "metrics.json");
            ModelMetrics? metrics = null;
            if (File.Exists(metricsPath))
            {
                var json = await File.ReadAllTextAsync(metricsPath);
                try
                {
                    var doc = JsonDocument.Parse(json);
                    metrics = new ModelMetrics
                    {
                        EvalF1 = GetMetric(doc, "eval_f1"),
                        EvalAccuracy = GetMetric(doc, "eval_accuracy"),
                        EvalPrecision = GetMetric(doc, "eval_precision"),
                        EvalRecall = GetMetric(doc, "eval_recall"),
                    };
                }
                catch { /* ignore parse errors */ }
            }

            _status = new ModelStatus { Loaded = true, Path = modelDir, Metrics = metrics };
            return _status;
        }
        catch (Exception ex)
        {
            _status = new ModelStatus { Loaded = false, Error = ex.Message };
            return _status;
        }
    }

    public Task<PredictionResult> PredictAsync(string text, string? postText = null)
    {
        if (_session == null || _tokenizer == null)
            throw new InvalidOperationException("Model not loaded");

        // Match JS behavior: emoji demojize equivalent
        var cleanedComment = EmojiHelper.Demojize(text);
        var cleanedPost = postText != null ? EmojiHelper.Demojize(postText) : "";

        // Encode with dual-segment format
        var encoding = string.IsNullOrEmpty(cleanedPost)
            ? _tokenizer.Encode(cleanedComment, 512)
            : _tokenizer.EncodePair(cleanedPost, cleanedComment, 512);

        var inputs = new List<NamedOnnxValue>
        {
            NamedOnnxValue.CreateFromTensor("input_ids",
                new DenseTensor<long>(encoding.InputIds, [1, encoding.InputIds.Length])),
            NamedOnnxValue.CreateFromTensor("attention_mask",
                new DenseTensor<long>(encoding.AttentionMask, [1, encoding.AttentionMask.Length])),
            NamedOnnxValue.CreateFromTensor("token_type_ids",
                new DenseTensor<long>(encoding.TokenTypeIds, [1, encoding.TokenTypeIds.Length])),
        };

        using var results = _session.Run(inputs);
        var logits = results.First().AsTensor<float>();

        // Softmax
        var notSpamLogit = logits[0];
        var spamLogit = logits[1];
        var maxLogit = Math.Max(notSpamLogit, spamLogit);
        var exp0 = MathF.Exp(notSpamLogit - maxLogit);
        var exp1 = MathF.Exp(spamLogit - maxLogit);
        var sum = exp0 + exp1;
        var spamProb = exp1 / sum;

        return Task.FromResult(new PredictionResult
        {
            Spam = spamProb >= 0.5f,
            Confidence = spamProb
        });
    }

    public async Task<List<PredictionResult>> PredictBatchAsync(List<CommentInput> items)
    {
        var results = new List<PredictionResult>();
        foreach (var item in items)
        {
            try
            {
                results.Add(await PredictAsync(item.Text, item.PostText));
            }
            catch
            {
                results.Add(new PredictionResult { Spam = false, Confidence = 0 });
            }
        }
        return results;
    }

    public void Dispose()
    {
        _session?.Dispose();
    }

    private static double GetMetric(JsonDocument doc, string key)
    {
        if (doc.RootElement.TryGetProperty(key, out var el) && el.TryGetDouble(out var val))
            return val;
        return 0;
    }
}
