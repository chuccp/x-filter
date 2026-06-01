using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.I18n;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class FileItem : ObservableObject
{
    public string Name { get; init; } = "";
    public string SizeDisplay => FormatBytes(Size);
    public long Size { get; init; }

    [ObservableProperty] private int _percent;
    [ObservableProperty] private string _status = "";

    private static string FormatBytes(long bytes)
    {
        if (bytes >= 1_000_000) return $"{bytes / 1_000_000.0:F1} MB";
        if (bytes >= 1_000) return $"{bytes / 1_000.0:F1} KB";
        return $"{bytes} B";
    }
}

public partial class DownloadModelViewModel : ViewModelBase
{
    private readonly IHfDownloader _downloader;
    private readonly IModelService _model;
    private readonly II18nService _i18n;

    [ObservableProperty] private string _status = "";
    [ObservableProperty] private int _percent;
    [ObservableProperty] private string _currentFile = "";
    [ObservableProperty] private bool _isDownloading;
    [ObservableProperty] private bool _isComplete;
    [ObservableProperty] private bool _hasError;
    [ObservableProperty] private bool _hasStarted;

    // i18n-bound labels
    [ObservableProperty] private string _windowTitle = "";
    [ObservableProperty] private string _repoLabel = "";
    [ObservableProperty] private string _startButton = "";
    [ObservableProperty] private string _confirmButton = "";
    [ObservableProperty] private string _cancelButton = "";
    [ObservableProperty] private string _errorHint = "";

    [ObservableProperty] private string _repo = "coke123/x-spam-classifier";

    public ObservableCollection<FileItem> Files { get; } = new();

    public bool ModelLoaded { get; private set; }
    public string? ModelError { get; private set; }
    public string? ModelF1 { get; private set; }

    public event Action<bool>? CloseRequested;

    public DownloadModelViewModel(IHfDownloader downloader, IModelService model, II18nService i18n)
    {
        _downloader = downloader;
        _model = model;
        _i18n = i18n;
        RefreshLabels();
        Status = _i18n.T("download.status_ready");
        _i18n.LanguageChanged += (_, _) =>
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(RefreshLabels);
        };
    }

    private void RefreshLabels()
    {
        WindowTitle = _i18n.T("download.title");
        RepoLabel = _i18n.T("download.repo_label");
        StartButton = _i18n.T("download.btn_start");
        ConfirmButton = _i18n.T("download.btn_confirm");
        CancelButton = _i18n.T("download.btn_cancel");
        ErrorHint = _i18n.T("download.error_hint");
        if (!HasStarted)
            Status = _i18n.T("download.status_ready");
    }

    [RelayCommand]
    private async Task StartDownloadAsync()
    {
        if (string.IsNullOrWhiteSpace(Repo)) return;
        HasStarted = true;

        try
        {
            // Step 1: List files
            Status = _i18n.T("download.listing", new() { ["repo"] = Repo });
            var files = await _downloader.ListFilesAsync(Repo);

            if (files.Count == 0)
            {
                Status = _i18n.T("download.failed", new() { ["error"] = "No files found in repo" });
                HasError = true;
                return;
            }

            Files.Clear();
            foreach (var f in files)
                Files.Add(new FileItem { Name = f.Name, Size = f.Size, Status = "⏳" });

            // Step 2: Download files one by one
            IsDownloading = true;
            var dir = Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.LocalApplicationData), "x-filter", "models", "x-spam-classifier");

            var skipped = 0;
            for (int i = 0; i < Files.Count; i++)
            {
                var item = Files[i];
                item.Status = "⬇";
                CurrentFile = item.Name;
                Status = _i18n.T("download.downloading",
                    new() { ["percent"] = $"{(i + 1)}/{Files.Count}" });

                try
                {
                    var dest = Path.Combine(dir, item.Name);
                    if (File.Exists(dest))
                    {
                        item.Status = "✓";
                        item.Percent = 100;
                        skipped++;
                        continue;
                    }

                    await _downloader.DownloadFileAsync(Repo,
                        new HfFile { Name = item.Name, Size = item.Size },
                        dir,
                        progress =>
                        {
                            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                            {
                                item.Percent = progress.Percent;
                                var done = (double)Files.Sum(f => (long)(f.Percent / 100.0 * f.Size));
                                var total = (double)Math.Max(1, Files.Sum(f => f.Size));
                                Percent = (int)Math.Round(done / total * 100);
                            });
                        });
                    item.Percent = 100;
                    item.Status = "✓";
                }
                catch (OperationCanceledException)
                {
                    item.Status = "✗";
                    Status = _i18n.T("download.cancelled");
                    IsDownloading = false;
                    return;
                }
                catch (Exception ex)
                {
                    item.Status = "✗";
                    Status = _i18n.T("download.failed", new() { ["error"] = $"{item.Name}: {ex.Message}" });
                    HasError = true;
                    IsDownloading = false;
                    return;
                }
            }

            Status = _i18n.T("download.complete");
            IsDownloading = false;
            IsComplete = true;
        }
        catch (Exception ex)
        {
            var inner = ex.InnerException != null ? $"\n→ {ex.InnerException.Message}" : "";
            Status = _i18n.T("download.failed", new() { ["error"] = ex.Message + inner });
            HasError = true;
            IsDownloading = false;
        }
    }

    [RelayCommand]
    private async Task ConfirmAsync()
    {
        Status = _i18n.T("download.loading_model");
        IsComplete = false;
        try
        {
            var r = await _model.LoadModelAsync();
            ModelLoaded = r.Loaded;
            if (r.Loaded)
            {
                ModelF1 = r.Metrics?.EvalF1.ToString("F3");
                Status = _i18n.T("download.model_loaded", new() { ["f1"] = ModelF1 ?? "0" });
            }
            else
            {
                ModelError = r.Error;
                Status = _i18n.T("download.model_load_failed", new() { ["error"] = r.Error ?? "" });
            }
        }
        catch (Exception ex)
        {
            ModelLoaded = false;
            ModelError = ex.Message;
            Status = _i18n.T("download.model_load_failed", new() { ["error"] = ex.Message });
        }
        CloseRequested?.Invoke(ModelLoaded);
    }

    [RelayCommand]
    private void Cancel()
    {
        _downloader.Cancel();
        CloseRequested?.Invoke(false);
    }
}
