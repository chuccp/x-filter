using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class CollectViewModel : ViewModelBase
{
    private readonly IScraperService _scraper;
    private readonly ICdpClient _cdp;
    private readonly IDatabaseService _db;

    [ObservableProperty] private string _url = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private bool _isRunning;
    [ObservableProperty] private int _progress;
    [ObservableProperty] private string _progressText = "";
    [ObservableProperty] private string _liveComment = "";

    public ObservableCollection<string> History { get; } = new();

    public CollectViewModel(IScraperService scraper, ICdpClient cdp, IDatabaseService db)
    {
        _scraper = scraper;
        _cdp = cdp;
        _db = db;
        _scraper.ProgressChanged += (_, p) =>
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                Progress = p.Scroll;
                ProgressText = T("collect.progress", new()
                {
                    ["scroll"] = p.Scroll.ToString(),
                    ["total"] = p.Total.ToString(),
                    ["found"] = p.Found.ToString()
                });
                // Show the latest comment in real-time
                if (p.NewComments is { Count: > 0 })
                {
                    var last = p.NewComments[^1];
                    LiveComment = $"@{last.Username}: {last.Text}";
                }
            });
    }

    [RelayCommand]
    private async Task StartAsync()
    {
        if (string.IsNullOrWhiteSpace(Url) || !Url.Contains("x.com"))
        { Status = T("collect.invalid_url"); return; }
        if (!_cdp.IsConnected) { Status = T("block.not_connected"); return; }
        IsRunning = true; Progress = 0; Status = T("collect.scraping");
        try
        {
            var comments = await _scraper.ScrapeCommentsAsync(Url);
            var saved = _db.InsertComments(comments);
            Status = T("collect.done", new() { ["count"] = saved.ToString() });
            History.Insert(0, $"{DateTime.Now:HH:mm}  {Url}  — {saved}/{comments.Count}");
        }
        catch (Exception ex) { Status = T("collect.fail", new() { ["error"] = ex.Message }); }
        finally { IsRunning = false; }
    }

    [RelayCommand]
    private void Cancel() { _scraper.Cancel(); IsRunning = false; }
}
