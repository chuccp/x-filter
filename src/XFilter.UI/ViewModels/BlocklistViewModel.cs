using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.Models;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class BlocklistViewModel : ViewModelBase
{
    private readonly IDatabaseService _db;
    private readonly IBlockerService _blocker;
    private readonly IScraperService _scraper;
    private readonly ICdpClient _cdp;

    [ObservableProperty] private string _addInput = "";
    [ObservableProperty] private string _importText = "";
    [ObservableProperty] private string _blockUrl = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private string _log = "";
    [ObservableProperty] private bool _isRunning;
    [ObservableProperty] private int _count;
    [ObservableProperty] private string _countText = "";

    public ObservableCollection<BlocklistEntry> Entries { get; } = new();

    public BlocklistViewModel(IDatabaseService db, IBlockerService blocker, IScraperService scraper, ICdpClient cdp)
    {
        _db = db; _blocker = blocker; _scraper = scraper; _cdp = cdp;
        Load();
    }

    [RelayCommand] public void Load()
    {
        Entries.Clear();
        var total = 0; var blocked = 0;
        foreach (var e in _db.GetBlocklist())
        {
            Entries.Add(e);
            total++;
            if (e.IsBlocked != 0) blocked++;
        }
        Count = total;
        CountText = T("blocklist.count", new() { ["total"] = total.ToString(), ["blocked"] = blocked.ToString() });
    }

    [RelayCommand]
    private void Add()
    {
        var u = AddInput.Trim(); if (string.IsNullOrEmpty(u)) return;
        _db.AddToBlocklist(u); AddInput = ""; Load();
    }

    [RelayCommand]
    private void Remove(string username) { _db.RemoveFromBlocklist(username); Load(); }

    [RelayCommand] private void Clear() { _db.ClearBlocklist(); Load(); }

    [RelayCommand]
    private void Import()
    {
        var names = ImportText.Split(new[] { '\n', ',', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        _db.ImportBlocklist(names); ImportText = ""; Load();
    }

    [RelayCommand]
    private async Task StartBlock()
    {
        if (string.IsNullOrWhiteSpace(BlockUrl) || !BlockUrl.Contains("x.com"))
        { Status = T("block.invalid_url"); return; }
        if (!_cdp.IsConnected) { Status = T("block.not_connected"); return; }

        IsRunning = true; Status = T("blocklist.scanning"); Log = "";
        try
        {
            var usernames = _db.GetBlocklist().Select(e => e.Username).ToHashSet();
            var comments = await _scraper.ScrapeCommentsAsync(BlockUrl);
            var matched = comments.Where(c => usernames.Contains(c.Username.TrimStart('@'))).ToList();
            AppendLog(T("blocklist.done", new()
            {
                ["scanned"] = comments.Count.ToString(),
                ["matched"] = matched.Count.ToString(),
                ["blocked"] = "0"
            }));

            var blocked = 0;
            foreach (var c in matched)
            {
                try
                {
                    var tab = await _cdp.GetActiveTabAsync();
                    if (tab == null) break;
                    var sid = await _cdp.AttachToTargetAsync(tab.Id);
                    try
                    {
                        if (await _blocker.BlockSingleUserAsync(sid, c.Username))
                        {
                            blocked++;
                            _db.MarkBlockedInBlocklist(c.Username);
                            AppendLog($"✓ {c.Username}");
                        }
                    }
                    finally { await _cdp.DetachFromTargetAsync(sid); }
                    await Task.Delay(2000);
                }
                catch (Exception ex) { AppendLog($"✗ {c.Username}: {ex.Message}"); }
            }
            Status = T("blocklist.done", new()
            {
                ["scanned"] = comments.Count.ToString(),
                ["matched"] = matched.Count.ToString(),
                ["blocked"] = blocked.ToString()
            });
        }
        catch (Exception ex) { Status = T("blocklist.fail", new() { ["error"] = ex.Message }); }
        finally { IsRunning = false; Load(); }
    }

    [RelayCommand] private void CancelBlock() { _blocker.Cancel(); _scraper.Cancel(); IsRunning = false; }
    private void AppendLog(string msg) => Log += $"[{DateTime.Now:HH:mm:ss}] {msg}\n";
}
