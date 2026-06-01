using System.Diagnostics;
using System.Text.Json;
using XFilter.Core.Data;
using XFilter.Core.Models;

namespace XFilter.Core.Services;

public class TrainingProgress
{
    public string Type { get; set; } = "";  // status, progress, metrics, log
    public string? Text { get; set; }
    public int Epoch { get; set; }
    public int TotalEpochs { get; set; }
    public double? Step { get; set; }
    public double? TotalSteps { get; set; }
    public ModelMetrics? Metrics { get; set; }
}

public class EnvCheckResult
{
    public bool Python { get; set; }
    public string? PythonCmd { get; set; }
    public string? PythonVersion { get; set; }
    public bool CudaAvailable { get; set; }
    public string? CudaVersion { get; set; }
    public string? CudaTag { get; set; }
    public bool PackagesOk { get; set; }
    public string? PackageDetail { get; set; }
}

public interface ITrainingService
{
    event EventHandler<TrainingProgress>? ProgressChanged;
    event EventHandler<string>? InstallLog;
    Task<EnvCheckResult> CheckEnvAsync(CancellationToken ct = default);
    Task<bool> InstallDepsAsync(CancellationToken ct = default);
    Task<bool> StartTrainingAsync(string csvPath, string outputDir, string? modelPath = null,
        int epochs = 20, int batchSize = 16, CancellationToken ct = default);
    void CancelTraining();
    Task<bool> UploadToHubAsync(string repo, string token, string modelDir, CancellationToken ct = default);
}

public class TrainingService : ITrainingService
{
    private readonly IDatabaseService _db;
    private Process? _trainingProcess;
    private string? _pythonCmd;

    public event EventHandler<TrainingProgress>? ProgressChanged;
    public event EventHandler<string>? InstallLog;

    public TrainingService(IDatabaseService db)
    {
        _db = db;
    }

    public async Task<EnvCheckResult> CheckEnvAsync(CancellationToken ct = default)
    {
        var result = new EnvCheckResult();
        _pythonCmd = await FindPythonAsync();

        if (_pythonCmd != null)
        {
            result.Python = true;
            result.PythonCmd = _pythonCmd;
            result.PythonVersion = await GetPythonVersionAsync(_pythonCmd);
        }

        // Check CUDA
        try
        {
            var nvidiaInfo = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "nvidia-smi",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }
            };
            nvidiaInfo.Start();
            var output = await nvidiaInfo.StandardOutput.ReadToEndAsync();
            await nvidiaInfo.WaitForExitAsync(ct);

            if (nvidiaInfo.ExitCode == 0)
            {
                var match = System.Text.RegularExpressions.Regex.Match(output, @"CUDA Version:\s*(\d+\.\d+)");
                if (match.Success)
                {
                    result.CudaAvailable = true;
                    result.CudaVersion = match.Groups[1].Value;
                    result.CudaTag = result.CudaVersion switch
                    {
                        "13.0" => "cu130",
                        "12.8" => "cu128",
                        "12.4" => "cu124",
                        "12.1" => "cu121",
                        "11.8" => "cu118",
                        _ => "cu121"
                    };
                }
            }
        }
        catch { /* no CUDA */ }

        // Check Python packages
        if (result.Python)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = _pythonCmd,
                    Arguments = "-c \"import transformers, torch, datasets, sklearn, pandas; print('all ok')\"",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                var proc = Process.Start(psi)!;
                var output = (await proc.StandardOutput.ReadToEndAsync()) +
                             (await proc.StandardError.ReadToEndAsync());
                await proc.WaitForExitAsync(ct);
                result.PackagesOk = proc.ExitCode == 0 && output.Contains("all ok");
                result.PackageDetail = output.Trim();
            }
            catch { /* package check failed */ }
        }

        return result;
    }

    public async Task<bool> InstallDepsAsync(CancellationToken ct = default)
    {
        if (_pythonCmd == null)
        {
            _pythonCmd = await FindPythonAsync();
            if (_pythonCmd == null) return false;
        }

        var deps = new[] {
            "transformers", "torch", "accelerate>=0.26.0", "datasets",
            "optimum[onnxruntime]", "scikit-learn", "pandas", "huggingface_hub", "emoji"
        };

        foreach (var dep in deps)
        {
            Log($"Installing {dep}...");
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = _pythonCmd,
                    Arguments = $"-m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn {dep}",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                var proc = Process.Start(psi)!;
                while (!proc.StandardOutput.EndOfStream)
                {
                    var line = await proc.StandardOutput.ReadLineAsync(ct);
                    if (line != null) Log(line);
                }
                while (!proc.StandardError.EndOfStream)
                {
                    var line = await proc.StandardError.ReadLineAsync(ct);
                    if (line != null) Log(line);
                }
                await proc.WaitForExitAsync(ct);
                if (proc.ExitCode != 0)
                    Log($"Warning: {dep} may not have installed correctly");
            }
            catch (Exception ex)
            {
                Log($"Failed to install {dep}: {ex.Message}");
            }
        }

        Log("Dependency installation complete");
        return true;
    }

    public async Task<bool> StartTrainingAsync(string csvPath, string outputDir, string? modelPath = null,
        int epochs = 20, int batchSize = 16, CancellationToken ct = default)
    {
        if (_pythonCmd == null)
        {
            _pythonCmd = await FindPythonAsync();
            if (_pythonCmd == null)
            {
                Report(new TrainingProgress { Type = "status", Text = "Python not found" });
                return false;
            }
        }

        // Export labeled data if csvPath doesn't exist
        if (!File.Exists(csvPath))
        {
            var rows = _db.ExportLabeledComments();
            var csvDir = Path.GetDirectoryName(csvPath)!;
            Directory.CreateDirectory(csvDir);
            var csv = "text,post_text,label\n" + string.Join("\n",
                rows.Select(r => $"\"{EscapeCsv(r.Text)}\",\"{EscapeCsv(r.PostText ?? "")}\",{r.Label}"));
            await File.WriteAllTextAsync(csvPath, csv, ct);
        }

        var trainScript = FindTrainScript();
        if (trainScript == null)
        {
            Report(new TrainingProgress { Type = "status", Text = "train.py not found" });
            return false;
        }

        Report(new TrainingProgress { Type = "status", Text = $"Using {trainScript}" });
        Report(new TrainingProgress { Type = "status", Text = "Starting training..." });

        _trainingProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = _pythonCmd,
                Arguments = $"\"{trainScript}\" --csv \"{csvPath}\" --output \"{outputDir}\" {(modelPath != null ? $"--model \"{modelPath}\"" : "")} --epochs {epochs} --batch-size {batchSize}",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            },
        };

        _trainingProcess.OutputDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            ProcessTrainingLine(e.Data);
        };
        _trainingProcess.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null)
                Report(new TrainingProgress { Type = "log", Text = $"[stderr] {e.Data}" });
        };

        _trainingProcess.Start();
        _trainingProcess.BeginOutputReadLine();
        _trainingProcess.BeginErrorReadLine();
        await _trainingProcess.WaitForExitAsync(ct);

        var success = _trainingProcess.ExitCode == 0;
        _trainingProcess = null;

        if (success)
            Report(new TrainingProgress { Type = "status", Text = "Training complete" });

        return success;
    }

    public void CancelTraining()
    {
        try { _trainingProcess?.Kill(); } catch { /* ignore */ }
        _trainingProcess = null;
    }

    public async Task<bool> UploadToHubAsync(string repo, string token, string modelDir, CancellationToken ct = default)
    {
        if (_pythonCmd == null) _pythonCmd = await FindPythonAsync();
        if (_pythonCmd == null) return false;

        var uploadScript = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "upload_to_hf.py");
        if (!File.Exists(uploadScript))
        {
            Report(new TrainingProgress { Type = "status", Text = "upload_to_hf.py not found" });
            return false;
        }

        var psi = new ProcessStartInfo
        {
            FileName = _pythonCmd,
            Arguments = $"\"{uploadScript}\" --repo \"{repo}\" --input \"{modelDir}\"",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.Environment["HF_TOKEN"] = token;

        var proc = Process.Start(psi)!;
        while (!proc.StandardOutput.EndOfStream)
        {
            var line = await proc.StandardOutput.ReadLineAsync(ct);
            if (line != null)
            {
                if (line.StartsWith("[STATUS]"))
                    Report(new TrainingProgress { Type = "status", Text = line[9..] });
                else
                    Report(new TrainingProgress { Type = "log", Text = line });
            }
        }
        await proc.WaitForExitAsync(ct);
        return proc.ExitCode == 0;
    }

    private void ProcessTrainingLine(string line)
    {
        if (line.StartsWith("[STATUS]"))
            Report(new TrainingProgress { Type = "status", Text = line[9..] });
        else if (line.StartsWith("[PROGRESS]"))
        {
            try
            {
                var doc = JsonDocument.Parse(line[11..]);
                Report(new TrainingProgress
                {
                    Type = "progress",
                    Epoch = doc.RootElement.TryGetProperty("epoch", out var ep) ? ep.GetInt32() : 0,
                    TotalEpochs = doc.RootElement.TryGetProperty("total_epochs", out var te) ? te.GetInt32() : 0,
                    Step = doc.RootElement.TryGetProperty("step", out var s) ? s.GetDouble() : null,
                    TotalSteps = doc.RootElement.TryGetProperty("total_steps", out var ts) ? ts.GetDouble() : null,
                });
            }
            catch { /* ignore */ }
        }
        else if (line.StartsWith("[METRICS]"))
        {
            try
            {
                var doc = JsonDocument.Parse(line[10..]);
                Report(new TrainingProgress
                {
                    Type = "metrics",
                    Metrics = new ModelMetrics
                    {
                        EvalF1 = GetDouble(doc, "eval_f1"),
                        EvalAccuracy = GetDouble(doc, "eval_accuracy"),
                        EvalPrecision = GetDouble(doc, "eval_precision"),
                        EvalRecall = GetDouble(doc, "eval_recall"),
                    }
                });
            }
            catch { /* ignore */ }
        }
        else
        {
            Report(new TrainingProgress { Type = "log", Text = line });
        }
    }

    private void Report(TrainingProgress p) => ProgressChanged?.Invoke(this, p);
    private void Log(string msg) => InstallLog?.Invoke(this, msg);

    private static async Task<string?> FindPythonAsync()
    {
        foreach (var cmd in new[] { "python", "python3", "py" })
        {
            try
            {
                var proc = Process.Start(new ProcessStartInfo
                {
                    FileName = cmd,
                    Arguments = "--version",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                });
                if (proc != null)
                {
                    await proc.WaitForExitAsync();
                    if (proc.ExitCode == 0) return cmd;
                }
            }
            catch { /* not found, try next */ }
        }
        return null;
    }

    private static async Task<string?> GetPythonVersionAsync(string cmd)
    {
        try
        {
            var proc = Process.Start(new ProcessStartInfo
            {
                FileName = cmd,
                Arguments = "--version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (proc == null) return null;
            var output = (await proc.StandardOutput.ReadToEndAsync()) + (await proc.StandardError.ReadToEndAsync());
            await proc.WaitForExitAsync();
            return output.Trim();
        }
        catch { return null; }
    }

    private static string? FindTrainScript()
    {
        var dirs = new[] {
            AppDomain.CurrentDomain.BaseDirectory,
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", ".."),
        };
        foreach (var dir in dirs)
        {
            var path = Path.Combine(dir, "train.py");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static string EscapeCsv(string? field)
    {
        return (field ?? "").Replace("\r\n", "\n").Replace("\r", "\n").Replace("\"", "\"\"");
    }

    private static double GetDouble(JsonDocument doc, string key)
    {
        if (doc.RootElement.TryGetProperty(key, out var el) && el.TryGetDouble(out var val))
            return val;
        return 0;
    }
}
