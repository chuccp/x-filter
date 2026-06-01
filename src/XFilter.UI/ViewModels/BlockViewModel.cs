using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.DependencyInjection;
using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.I18n;
using XFilter.Core.Services;
using XFilter.UI.Views;

namespace XFilter.UI.ViewModels;

public partial class BlockViewModel : ViewModelBase
{
    private readonly IScraperService _scraper;
    private readonly IBlockerService _blocker;
    private readonly IModelService _model;
    private readonly ICdpClient _cdp;
    private readonly IDatabaseService _db;
    private readonly IServiceProvider _services;

    [ObservableProperty] private string _url = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private string _log = "";
    [ObservableProperty] private double _threshold = 0.8;
    [ObservableProperty] private bool _isRunning;
    [ObservableProperty] private string _modelInfo = "";
    [ObservableProperty] private bool _isModelLoaded;

    public BlockViewModel(IScraperService scraper, IBlockerService blocker,
        IModelService model, ICdpClient cdp, IDatabaseService db, IServiceProvider services)
    {
        _scraper = scraper;
        _blocker = blocker;
        _model = model;
        _cdp = cdp;
        _db = db;
        _services = services;

        ModelInfo = T("block.model_checking");
        UpdateModelStatus();

        // Refresh on language change
        var i18n = services.GetService(typeof(II18nService)) as II18nService;
        if (i18n != null)
            i18n.LanguageChanged += (_, _) =>
                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    UpdateModelStatus();
                });
    }

    private void UpdateModelStatus()
    {
        var st = _model.GetStatus();
        IsModelLoaded = st.Loaded;
        ModelInfo = st.Loaded
            ? T("block.model_loaded", new() { ["f1"] = st.Metrics?.EvalF1.ToString("F3") ?? "?" })
            : (st.Error != null ? st.Error : T("block.model_not_loaded"));
    }

    [RelayCommand]
    private async Task LoadModel()
    {
        ModelInfo = T("block.loading_model");
        var r = await _model.LoadModelAsync();
        IsModelLoaded = r.Loaded;
        ModelInfo = r.Loaded
            ? T("block.model_loaded", new() { ["f1"] = r.Metrics?.EvalF1.ToString("F3") ?? "?" })
            : T("block.fail", new() { ["error"] = r.Error ?? "" });
    }

    [RelayCommand]
    private async Task DownloadModel()
    {
        var downloadVm = _services.GetRequiredService<DownloadModelViewModel>();

        var window = new DownloadModelWindow { DataContext = downloadVm };
        var mainWindow = (Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.MainWindow;
        if (mainWindow != null)
            await window.ShowDialog(mainWindow);

        // Auto-load model after popup closes
        var st = _model.GetStatus();
        if (!st.Loaded && downloadVm.ModelLoaded)
            st = await _model.LoadModelAsync();

        IsModelLoaded = st.Loaded;
        ModelInfo = st.Loaded
            ? T("block.model_loaded", new() { ["f1"] = st.Metrics?.EvalF1.ToString("F3") ?? "?" })
            : (st.Error ?? T("block.model_not_loaded"));

        if (mainWindow?.DataContext is MainViewModel mainVm)
            mainVm.OnModelStatusChanged(st.Loaded, st.Metrics?.EvalF1.ToString("F3"));
    }

    [RelayCommand]
    private async Task StartAsync()
    {
        if (string.IsNullOrWhiteSpace(Url) || !Url.Contains("x.com"))
        {
            Status = T("block.invalid_url");
            return;
        }
        if (!_cdp.IsConnected)
        {
            Status = T("block.not_connected");
            return;
        }
        if (!IsModelLoaded)
        {
            Status = T("block.model_not_loaded");
            return;
        }

        IsRunning = true;
        Status = T("block.scraping_log", new() { ["found"] = "0" });
        Log = "";

        try
        {
            var comments = await _scraper.ScrapeCommentsAsync(Url);
            AppendLog(T("block.scraping_log", new() { ["found"] = comments.Count.ToString() }));

            Status = T("block.predicting_progress", new() { ["total"] = comments.Count.ToString(), ["spam"] = "0" });
            var scanned = 0;
            var spam = 0;
            var blocked = 0;

            foreach (var c in comments)
            {
                var result = await _model.PredictAsync(c.Text, c.PostText);
                scanned++;
                if (result.Spam && result.Confidence >= Threshold)
                {
                    spam++;
                    AppendLog(T("block.predicting_log", new() { ["spam"] = spam.ToString() }));
                }

                if (scanned % 10 == 0)
                    Status = T("block.scanning_log", new()
                    {
                        ["username"] = c.Username,
                        ["scanned"] = scanned.ToString(),
                        ["spam"] = spam.ToString()
                    });
            }

            AppendLog(T("block.done", new()
            {
                ["scanned"] = scanned.ToString(),
                ["spam"] = spam.ToString(),
                ["blocked"] = blocked.ToString()
            }));

            if (spam > 0)
            {
                Status = T("block.blocking_progress", new()
                {
                    ["scanned"] = "0",
                    ["total"] = spam.ToString(),
                    ["blocked"] = "0"
                });

                var spamComments = comments
                    .Where(c => _model.PredictAsync(c.Text, c.PostText).Result is { Spam: true, Confidence: >= 0.8f })
                    .Take(spam).ToList();

                foreach (var c in spamComments)
                {
                    if (_db.IsUserBlocked(c.Username))
                    {
                        AppendLog($"⏭ @{c.Username}");
                        continue;
                    }

                    try
                    {
                        var target = await _cdp.GetActiveTabAsync();
                        if (target == null) break;
                        var sid = await _cdp.AttachToTargetAsync(target.Id);
                        try
                        {
                            var ok = await _blocker.BlockSingleUserAsync(sid, c.Username);
                            if (ok)
                            {
                                blocked++;
                                AppendLog(T("block.blocked_log", new() { ["username"] = c.Username }));
                            }
                        }
                        finally { await _cdp.DetachFromTargetAsync(sid); }
                    }
                    catch (Exception ex) { AppendLog(T("block.error_log", new() { ["error"] = ex.Message })); }
                }
            }

            Status = T("block.done", new()
            {
                ["scanned"] = scanned.ToString(),
                ["spam"] = spam.ToString(),
                ["blocked"] = blocked.ToString()
            });
        }
        catch (Exception ex)
        {
            Status = T("block.fail", new() { ["error"] = ex.Message });
            AppendLog(T("block.error_log", new() { ["error"] = ex.Message }));
        }
        finally
        {
            IsRunning = false;
        }
    }

    [RelayCommand]
    private void Cancel()
    {
        _scraper.Cancel();
        _blocker.Cancel();
        IsRunning = false;
        Status = T("block.cancelled");
    }

    private void AppendLog(string msg)
    {
        var ts = DateTime.Now.ToString("HH:mm:ss");
        Log += $"[{ts}] {msg}\n";
        // Limit log
        var lines = Log.Split('\n');
        if (lines.Length > 200)
            Log = string.Join('\n', lines[^200..]);
    }
}
