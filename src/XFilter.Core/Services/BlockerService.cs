using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.Models;

namespace XFilter.Core.Services;

public class BlockProgress
{
    public string Phase { get; set; } = "";
    public int Scanned { get; set; }
    public int Matched { get; set; }
    public int Blocked { get; set; }
    public int Errors { get; set; }
    public string? Username { get; set; }
    public string? Text { get; set; }
    public string? Error { get; set; }
    public int Posts { get; set; }
    public int Scroll { get; set; }
}

public interface IBlockerService
{
    event EventHandler<BlockProgress>? ProgressChanged;
    Task<BlockResult> BlockUsersAsync(string sourceUrl, List<ScrapedComment> comments, CancellationToken ct = default);
    Task<bool> BlockSingleUserAsync(string sessionId, string username, string? reason = null, CancellationToken ct = default);
    void Cancel();
}

public class BlockResult
{
    public int Scanned { get; set; }
    public int Blocked { get; set; }
    public int Errors { get; set; }
}

public class BlockerService : IBlockerService
{
    private readonly ICdpClient _cdp;
    private readonly IDatabaseService _db;
    private volatile bool _cancelled;

    public event EventHandler<BlockProgress>? ProgressChanged;

    public BlockerService(ICdpClient cdp, IDatabaseService db)
    {
        _cdp = cdp;
        _db = db;
    }

    public void Cancel() => _cancelled = true;

    public async Task<BlockResult> BlockUsersAsync(string sourceUrl, List<ScrapedComment> comments, CancellationToken ct = default)
    {
        _cancelled = false;
        var result = new BlockResult();

        var target = await _cdp.GetActiveTabAsync(ct);
        string sessionId;
        if (target != null && target.Url.Contains("x.com"))
        {
            await _cdp.ActivateTargetAsync(target.Id, ct);
            sessionId = await _cdp.AttachToTargetAsync(target.Id, ct);
        }
        else
        {
            sessionId = await _cdp.OpenNewTabAsync(sourceUrl, ct);
        }

        try
        {
            foreach (var comment in comments)
            {
                if (_cancelled) break;

                var username = comment.Username;
                if (string.IsNullOrEmpty(username) || _db.IsUserBlocked(username))
                {
                    result.Scanned++;
                    continue;
                }

                ProgressChanged?.Invoke(this, new BlockProgress
                {
                    Phase = "blocking",
                    Username = username,
                    Scanned = result.Scanned,
                    Blocked = result.Blocked,
                    Errors = result.Errors,
                });

                try
                {
                    var blocked = await BlockSingleUserAsync(sessionId, username, ct: ct);
                    if (blocked)
                        result.Blocked++;
                    else
                        result.Errors++;

                    await Task.Delay(2000, ct); // Rate limit
                }
                catch
                {
                    result.Errors++;
                }

                result.Scanned++;
            }
        }
        finally
        {
            await _cdp.DetachFromTargetAsync(sessionId, ct);
        }

        return result;
    }

    public async Task<bool> BlockSingleUserAsync(string sessionId, string username,
        string? reason = null, CancellationToken ct = default)
    {
        try
        {
            // Save scroll position and dismiss any open UI
            await _cdp.EvaluateAsync(sessionId,
                "var __saveScrollY = window.scrollY; " +
                "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}));", ct);

            // Step 1: Find article with this username and click the caret menu
            var step1Js = $@"(function(){{
                var articles = document.querySelectorAll('article[data-testid=""tweet""]');
                for(var i=0;i<articles.length;i++){{
                    var spans = articles[i].querySelectorAll('span');
                    var found = false;
                    spans.forEach(function(s){{
                        if(s.textContent && s.textContent.trim() === '@{username}') found = true;
                    }});
                    if(found){{
                        var caret = articles[i].querySelector('button[data-testid=""caret""]');
                        if(caret){{
                            caret.scrollIntoView({{block:'center'}});
                            caret.click();
                            return {{clicked:true}};
                        }}
                    }}
                }}
                return {{error:'Could not find caret for @{username}'}};
            }})()";

            var step1 = await _cdp.EvaluateAsync(sessionId, step1Js, ct);
            if (!step1.TryGetProperty("clicked", out _))
            {
                // Dismiss on failure
                await _cdp.EvaluateAsync(sessionId,
                    "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}))", ct);
                return false;
            }

            await Task.Delay(800, ct);

            // Step 2: Click "Block" in the menu
            var step2Js = @"(function(){
                var items = document.querySelectorAll('[role=""menu""] [role=""menuitem""]');
                for(var i=0;i<items.length;i++){
                    var t = items[i].textContent || '';
                    if(t.includes('Block') || t.includes('屏蔽')){
                        items[i].click();
                        return {clicked:true};
                    }
                }
                return {error:'Could not find Block menu item'};
            })()";

            var step2 = await _cdp.EvaluateAsync(sessionId, step2Js, ct);
            if (!step2.TryGetProperty("clicked", out _))
            {
                await _cdp.EvaluateAsync(sessionId,
                    "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}))", ct);
                return false;
            }

            await Task.Delay(800, ct);

            // Step 3: Click confirm
            var step3Js = $@"(function(){{
                var confirm = document.querySelector('[data-testid=""confirmationSheetConfirm""]');
                if(!confirm) return {{error:'Could not find confirm button'}};
                confirm.click();
                return {{clicked:true}};
            }})()";

            var step3 = await _cdp.EvaluateAsync(sessionId, step3Js, ct);
            await Task.Delay(1000, ct);

            // Restore scroll position
            await _cdp.EvaluateAsync(sessionId,
                "if(typeof __saveScrollY !== 'undefined') window.scrollTo(0, __saveScrollY);", ct);

            if (step3.TryGetProperty("clicked", out _))
            {
                _db.AddBlockedUser(username, reason: reason);
                ProgressChanged?.Invoke(this, new BlockProgress { Phase = "blocked", Username = username });
                return true;
            }
            return false;
        }
        catch (Exception ex)
        {
            // Dismiss any open UI
            try
            {
                await _cdp.EvaluateAsync(sessionId,
                    "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true}))", ct);
            }
            catch { /* ignore */ }

            ProgressChanged?.Invoke(this, new BlockProgress { Phase = "error", Username = username, Error = ex.Message });
            return false;
        }
    }
}
