using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Data;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class TrainViewModel : ViewModelBase
{
    private readonly ITrainingService _training;
    private readonly IModelService _model;
    private readonly IDatabaseService _db;

    [ObservableProperty] private string _envInfo = "";
    [ObservableProperty] private string _log = "";
    [ObservableProperty] private int _epochs = 20;
    [ObservableProperty] private int _batchSize = 16;
    [ObservableProperty] private bool _isTraining;
    [ObservableProperty] private bool _envReady;
    [ObservableProperty] private string _epochProgress = "";
    [ObservableProperty] private string _trainedModelInfo = "";

    public TrainViewModel(ITrainingService training, IModelService model, IDatabaseService db)
    {
        _training = training; _model = model; _db = db;
        EnvInfo = T("train.env_checking");
        _training.ProgressChanged += (_, p) =>
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                if (p.Type == "status") AppendLog(p.Text ?? "");
                else if (p.Type == "progress")
                    EpochProgress = T("train.epoch_progress", new()
                    {
                        ["epoch"] = p.Epoch.ToString(),
                        ["total"] = p.TotalEpochs.ToString()
                    });
                else if (p.Type == "log") AppendLog(p.Text ?? "");
                else if (p.Type == "metrics" && p.Metrics != null)
                    AppendLog(T("train.metrics_format", new()
                    {
                        ["f1"] = (p.Metrics.EvalF1 * 100).ToString("F1"),
                        ["accuracy"] = (p.Metrics.EvalAccuracy * 100).ToString("F1"),
                        ["precision"] = (p.Metrics.EvalPrecision * 100).ToString("F1"),
                        ["recall"] = (p.Metrics.EvalRecall * 100).ToString("F1")
                    }));
            });
        _training.InstallLog += (_, msg) =>
            Avalonia.Threading.Dispatcher.UIThread.Post(() => AppendLog(msg));
    }

    [RelayCommand]
    private async Task CheckEnv()
    {
        EnvInfo = T("train.env_checking");
        var r = await _training.CheckEnvAsync();
        EnvInfo = r.Python
            ? T("train.cuda_available", new() { ["version"] = r.CudaVersion ?? "N/A", ["tag"] = r.CudaAvailable ? "CUDA" : "CPU" })
            : T("train.python_not_found");
        EnvReady = r.Python;
    }

    [RelayCommand]
    private async Task InstallDeps()
    {
        EnvInfo = T("train.installing");
        await _training.InstallDepsAsync();
        await CheckEnv();
    }

    [RelayCommand]
    private async Task StartTraining()
    {
        var rows = _db.ExportLabeledComments();
        if (rows.Count < 10)
        {
            AppendLog(T("train.not_enough_data", new() { ["got"] = rows.Count.ToString() }));
            return;
        }

        IsTraining = true; Log = ""; EpochProgress = "";
        var csvDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "x-filter", "data");
        Directory.CreateDirectory(csvDir);
        var csvPath = Path.Combine(csvDir, "training_data.csv");
        var outputDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "x-filter", "models", "x-spam-classifier");

        var csv = "text,post_text,label\n" + string.Join("\n",
            rows.Select(r => $"\"{Esc(r.Text.Replace("\n"," ").Replace("\r",""))}\",\"{Esc(r.PostText?.Replace("\n"," ")?.Replace("\r","") ?? "")}\",{r.Label}"));
        File.WriteAllText(csvPath, csv);

        try
        {
            var ok = await _training.StartTrainingAsync(csvPath, outputDir, epochs: Epochs, batchSize: BatchSize);
            AppendLog(ok ? T("train.done") : T("train.fail", new() { ["error"] = "" }));
            if (ok) { await _model.LoadModelAsync(outputDir); TrainedModelInfo = T("train.model_loaded"); }
        }
        finally { IsTraining = false; }
    }

    [RelayCommand]
    private void CancelTraining() { _training.CancelTraining(); IsTraining = false; }

    private void AppendLog(string msg) => Log += $"[{DateTime.Now:HH:mm:ss}] {msg}\n";
    private static string Esc(string? s) => (s ?? "").Replace("\"", "\"\"");
}
