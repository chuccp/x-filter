using System.Text.Json;
using XFilter.Core.Cdp;
using XFilter.Core.Models;

namespace XFilter.Core.Services;

public class ScrapeProgress
{
    public string Phase { get; set; } = "";  // listing, scraping, status
    public int Found { get; set; }
    public int Scroll { get; set; }
    public int Total { get; set; }
    public int PostIndex { get; set; } = 1;
    public int PostTotal { get; set; } = 1;
    public List<ScrapedComment>? NewComments { get; set; }
}

public interface IScraperService
{
    event EventHandler<ScrapeProgress>? ProgressChanged;
    Task<List<ScrapedComment>> ScrapeCommentsAsync(string url, CancellationToken ct = default);
    Task<List<string>> ScrapeProfilePostsAsync(string profileUrl, CancellationToken ct = default);
    Task<List<ScrapedComment>> ScrapeInSessionAsync(string sessionId, string url,
        Action<ScrapedComment>? onNewComment = null, CancellationToken ct = default);
    bool IsProfileUrl(string url);
    void Cancel();
}

public class ScraperService : IScraperService
{
    private readonly ICdpClient _cdp;
    private volatile bool _cancelled;
    private int _maxScroll = 50;
    private int _scrollDelay = 500;

    public event EventHandler<ScrapeProgress>? ProgressChanged;

    public ScraperService(ICdpClient cdp)
    {
        _cdp = cdp;
    }

    public bool IsProfileUrl(string url)
    {
        return url.Contains("x.com") && !url.Contains("/status/");
    }

    public void Cancel() => _cancelled = true;

    public async Task<List<ScrapedComment>> ScrapeCommentsAsync(string url, CancellationToken ct = default)
    {
        _cancelled = false;
        var target = await _cdp.GetActiveTabAsync(ct);
        string sessionId;
        if (target != null && target.Url.Contains("x.com"))
        {
            await _cdp.ActivateTargetAsync(target.Id, ct);
            sessionId = await _cdp.AttachToTargetAsync(target.Id, ct);
        }
        else
        {
            sessionId = await _cdp.OpenNewTabAsync(url, ct);
        }
        try
        {
            return await ScrapeWithSessionAsync(sessionId, url, null, ct);
        }
        finally
        {
            await _cdp.DetachFromTargetAsync(sessionId, ct);
        }
    }

    public async Task<List<string>> ScrapeProfilePostsAsync(string profileUrl, CancellationToken ct = default)
    {
        _cancelled = false;
        var target = await _cdp.GetActiveTabAsync(ct);
        string sessionId;
        if (target != null && target.Url.Contains("x.com"))
        {
            await _cdp.ActivateTargetAsync(target.Id, ct);
            sessionId = await _cdp.AttachToTargetAsync(target.Id, ct);
        }
        else
        {
            sessionId = await _cdp.OpenNewTabAsync(profileUrl, ct);
        }
        try
        {
            return await ScrapeProfileWithSessionAsync(sessionId, profileUrl, ct);
        }
        finally
        {
            await _cdp.DetachFromTargetAsync(sessionId, ct);
        }
    }

    public async Task<List<ScrapedComment>> ScrapeInSessionAsync(string sessionId, string url,
        Action<ScrapedComment>? onNewComment = null, CancellationToken ct = default)
    {
        _cancelled = false;
        return await ScrapeWithSessionAsync(sessionId, url, onNewComment, ct);
    }

    private async Task<List<ScrapedComment>> ScrapeWithSessionAsync(string sessionId, string url,
        Action<ScrapedComment>? onNewComment, CancellationToken ct)
    {
        await _cdp.NavigatePageAsync(sessionId, url, ct);
        await _cdp.WaitForPageLoadAsync(sessionId, 15000, ct);
        await _cdp.WaitForSelectorAsync(sessionId, CdpConstants.TweetArticle, 30000, ct);

        // Login wall check
        var bodyText = (await _cdp.EvaluateAsync(sessionId, "document.body.innerText", ct)).GetString() ?? "";
        if (bodyText.Contains("Sign in") || bodyText.Contains("Log in"))
            throw new Exception("Login required — please log in to X.com in Chrome first");

        var comments = new List<ScrapedComment>();
        var seenTexts = new HashSet<string>();
        string? postText = null;
        var noNewCount = 0;
        var firstArticle = true;

        for (var i = 0; i < _maxScroll && !_cancelled && noNewCount < 8; i++)
        {
            var extractJs = ExtractArticlesJs();
            var result = await _cdp.EvaluateAsync(sessionId, extractJs, ct);
            var articles = result.EnumerateArray().ToList();

            if (articles.Count == 0) break;

            var newInThisScroll = 0;
            var newInBatch = new List<ScrapedComment>();
            foreach (var article in articles)
            {
                if (_cancelled) break;
                var text = article.GetProperty("text").GetString() ?? "";
                var username = article.GetProperty("username").GetString() ?? "";
                var normalized = System.Text.RegularExpressions.Regex.Replace(text, @"\s+", " ").Trim();

                if (string.IsNullOrEmpty(normalized) || seenTexts.Contains(normalized)) continue;
                seenTexts.Add(normalized);

                if (firstArticle && postText == null)
                {
                    postText = text;
                    firstArticle = false;
                    continue;
                }
                firstArticle = false;

                var comment = new ScrapedComment { Text = text, Username = username, PostText = postText ?? "" };
                comments.Add(comment);
                newInBatch.Add(comment);
                onNewComment?.Invoke(comment);
                newInThisScroll++;
            }

            if (newInThisScroll == 0)
                noNewCount++;
            else
                noNewCount = 0;

            ProgressChanged?.Invoke(this, new ScrapeProgress
            {
                Phase = "scraping",
                Found = comments.Count,
                Scroll = i + 1,
                Total = _maxScroll,
                NewComments = newInBatch.Count > 0 ? newInBatch.ToList() : null,
            });

            // Scroll down
            await _cdp.EvaluateAsync(sessionId, "window.scrollBy(0, 400)", ct);
            await Task.Delay(_scrollDelay, ct);
        }

        ProgressChanged?.Invoke(this, new ScrapeProgress
        {
            Phase = "status",
            Found = comments.Count,
            Scroll = _maxScroll,
            Total = _maxScroll,
        });

        return comments;
    }

    private async Task<List<string>> ScrapeProfileWithSessionAsync(string sessionId, string url, CancellationToken ct)
    {
        await _cdp.NavigatePageAsync(sessionId, url, ct);
        await _cdp.WaitForPageLoadAsync(sessionId, 15000, ct);
        await _cdp.WaitForSelectorAsync(sessionId, CdpConstants.TweetArticle, 30000, ct);

        var postUrls = new HashSet<string>();
        var noNewCount = 0;

        for (var i = 0; i < _maxScroll && !_cancelled && noNewCount < 10; i++)
        {
            var countBefore = postUrls.Count;
            var extractJs = @"(function(){
                var links = document.querySelectorAll('a[href*=\""/status/\""]');
                var urls = [];
                links.forEach(function(a){
                    var m = a.href.match(/^https?:\/\/x\.com\/(\w+)\/status\/(\d+)/);
                    if(m) urls.push(a.href);
                });
                return [...new Set(urls)];
            })()";

            var result = await _cdp.EvaluateAsync(sessionId, extractJs, ct);
            foreach (var link in result.EnumerateArray())
                postUrls.Add(link.GetString()!);

            if (postUrls.Count == countBefore)
                noNewCount++;
            else
                noNewCount = 0;

            ProgressChanged?.Invoke(this, new ScrapeProgress
            {
                Phase = "listing",
                Found = postUrls.Count,
                Scroll = i + 1,
                Total = _maxScroll,
            });

            await _cdp.EvaluateAsync(sessionId, "window.scrollBy(0, 600)", ct);
            await Task.Delay(_scrollDelay, ct);
        }

        return postUrls.ToList();
    }

    private static string ExtractArticlesJs()
    {
        var textExtraction = @"function extractText(el){
            if(!el) return '';
            var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
            var text = '';
            var n;
            while(n = w.nextNode()){
                if(n.nodeType === Node.TEXT_NODE) text += n.textContent;
                else if(n.nodeType === Node.ELEMENT_NODE && n.tagName === 'IMG') text += n.alt || '';
            }
            return text.trim();
        }";

        return $@"(function(){{
            {textExtraction}
            var articles = document.querySelectorAll('article[data-testid=""tweet""]');
            var results = [];
            var stop = false;
            articles.forEach(function(a){{
                if(stop) return;
                // Check for Discover more boundary
                var spans = a.querySelectorAll('span');
                for(var i = 0; i < spans.length; i++){{
                    var t = spans[i].textContent || '';
                    if(t === '发现更多' || t === 'Discover more'){{
                        var cell = spans[i].closest('[data-testid=""cellInnerDiv""]');
                        if(cell) stop = true;
                        return;
                    }}
                }}
                if(stop) return;

                var textEl = a.querySelector('[data-testid=""tweetText""]');
                var text = extractText(textEl);

                // Get username from profile link
                var username = '';
                var links = a.querySelectorAll('a[role=""link""]');
                for(var j = 0; j < links.length; j++){{
                    var href = links[j].getAttribute('href') || '';
                    var m = href.match(/^\/(\w+)$/);
                    if(m && m[1] !== 'i' && !m[1].startsWith('hashtag')){{
                        username = m[1];
                        break;
                    }}
                }}
                // Fallback: look for @username span
                if(!username){{
                    var allSpans = a.querySelectorAll('span');
                    for(var k = 0; k < allSpans.length; k++){{
                        var txt = allSpans[k].textContent || '';
                        if(txt.startsWith('@')){{
                            username = txt.replace('@', '');
                            break;
                        }}
                    }}
                }}

                results.push({{text:text, username:username}});
            }});
            return results;
        }})()";
    }
}
