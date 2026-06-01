using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Cdp;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class CollectViewModel : ViewModelBase
{
    private readonly IScraperService _scraper;
    private readonly ICdpClient _cdp;

    [ObservableProperty] private string _url = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private bool _isRunning;
    [ObservableProperty] private int _progress;
    [ObservableProperty] private string _progressText = "";

    public ObservableCollection<string> History { get; } = new();

    public CollectViewModel(IScraperService scraper, ICdpClient cdp)
    {
        _scraper = scraper;
        _cdp = cdp;
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
            Status = T("collect.done", new() { ["count"] = comments.Count.ToString() });
            History.Insert(0, $"{DateTime.Now:HH:mm}  {Url}  — {comments.Count}");
        }
        catch (Exception ex) { Status = T("collect.fail", new() { ["error"] = ex.Message }); }
        finally { IsRunning = false; }
    }

    [RelayCommand]
    private void Cancel() { _scraper.Cancel(); IsRunning = false; }
}
