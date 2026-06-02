using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using XFilter.Core.Models;

namespace XFilter.Core.Cdp;

public interface ICdpClient
{
    bool IsConnected { get; }
    event EventHandler? Disconnected;
    Task ConnectAsync(string host = "127.0.0.1", int port = 9222, CancellationToken ct = default);
    void Disconnect();
    Task<List<CdpTargetInfo>> GetPageTargetsAsync(CancellationToken ct = default);
    Task<CdpTargetInfo?> GetActiveTabAsync(CancellationToken ct = default);
    Task ActivateTargetAsync(string targetId, CancellationToken ct = default);
    Task<string> AttachToTargetAsync(string targetId, CancellationToken ct = default);
    Task DetachFromTargetAsync(string sessionId, CancellationToken ct = default);
    Task NavigatePageAsync(string sessionId, string url, CancellationToken ct = default);
    Task WaitForPageLoadAsync(string sessionId, int timeoutMs = 15000, CancellationToken ct = default);
    Task WaitForSelectorAsync(string sessionId, string selector, int timeoutMs = 30000, CancellationToken ct = default);
    Task<string> OpenNewTabAsync(string url, CancellationToken ct = default);
    Task<JsonElement> EvaluateAsync(string sessionId, string expression, CancellationToken ct = default);
    Task<JsonElement> ClickElementAsync(string sessionId, string selector, CancellationToken ct = default);
    Task<JsonElement> SendCommandAsync(string method, object? parameters = null, string? sessionId = null, CancellationToken ct = default);
}

public class CdpException : Exception
{
    public CdpException(string message) : base(message) { }
}

public class CdpClient : ICdpClient, IDisposable
{
    private ClientWebSocket? _ws;
    private readonly ConcurrentDictionary<int, TaskCompletionSource<JsonElement>> _pending = new();
    private int _commandId;
    private CancellationTokenSource? _receiveCts;
    private readonly byte[] _buffer = new byte[65536];
    private string _host = "127.0.0.1";
    private int _port = 9222;

    public bool IsConnected => _ws?.State == WebSocketState.Open;
    public event EventHandler? Disconnected;

    public async Task ConnectAsync(string host = "127.0.0.1", int port = 9222, CancellationToken ct = default)
    {
        Disconnect();
        _disconnected = false;
        CancelAllPending("Connection reset");

        _host = host;
        _port = port;
        _ws = new ClientWebSocket();
        _receiveCts = new CancellationTokenSource();

        var uri = new Uri($"ws://{host}:{port}/devtools/browser");
        await _ws.ConnectAsync(uri, ct);
        _ = ReceiveLoopAsync(_receiveCts.Token);
    }

    private bool _disconnected;

    public void Disconnect()
    {
        if (_disconnected) return;
        _disconnected = true;
        _receiveCts?.Cancel();
        try { _ws?.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); }
        catch { /* ignore */ }
        _ws?.Dispose();
        _ws = null;
        CancelAllPending("Disconnected");
        Disconnected?.Invoke(this, EventArgs.Empty);
    }

    public void Dispose()
    {
        Disconnect();
        _receiveCts?.Dispose();
        _ws?.Dispose();
    }

    private void CancelAllPending(string reason)
    {
        foreach (var (_, tcs) in _pending)
            tcs.TrySetException(new CdpException(reason));
        _pending.Clear();
    }

    private async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var builder = new StringBuilder();
        while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
        {
            try
            {
                builder.Clear();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(_buffer, ct);
                    builder.Append(Encoding.UTF8.GetString(_buffer, 0, result.Count));
                } while (!result.EndOfMessage);

                ProcessMessage(builder.ToString());
            }
            catch (OperationCanceledException) { break; }
            catch { break; }
        }
        Disconnected?.Invoke(this, EventArgs.Empty);
    }

    private void ProcessMessage(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;

            if (root.TryGetProperty("id", out var idProp))
            {
                var id = idProp.GetInt32();
                if (_pending.TryRemove(id, out var tcs))
                {
                    if (root.TryGetProperty("error", out var error))
                    {
                        var msg = error.GetProperty("message").GetString() ?? "CDP error";
                        tcs.TrySetException(new CdpException(msg));
                    }
                    else if (root.TryGetProperty("result", out var result))
                    {
                        tcs.TrySetResult(result.Clone());
                    }
                    else
                    {
                        // Response with id but no result/error — treat as success with empty result
                        tcs.TrySetResult(default);
                    }
                }
            }
        }
        catch { /* ignore malformed messages */ }
    }

    public async Task<JsonElement> SendCommandAsync(string method, object? parameters = null,
        string? sessionId = null, CancellationToken ct = default)
    {
        if (_ws?.State != WebSocketState.Open)
            throw new CdpException("Not connected to Chrome");

        var id = Interlocked.Increment(ref _commandId);

        // Build JSON via JsonObject to avoid reflection-based JsonSerializer (disabled in .NET 9 trimmed apps)
        var msg = new JsonObject { ["id"] = id, ["method"] = method };
        if (parameters != null) msg["params"] = ToJsonNode(parameters);
        if (sessionId != null) msg["sessionId"] = sessionId;

        var json = msg.ToJsonString();
        var bytes = Encoding.UTF8.GetBytes(json);
        var tcs = new TaskCompletionSource<JsonElement>();
        _pending[id] = tcs;

        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct);

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(10_000);
        try
        {
            return await tcs.Task.WaitAsync(cts.Token);
        }
        catch (TimeoutException)
        {
            _pending.TryRemove(id, out _);
            throw new CdpException($"CDP command timeout: {method}");
        }
        catch (OperationCanceledException)
        {
            _pending.TryRemove(id, out _);
            throw;
        }
    }

    /// <summary>
    /// Convert an anonymous-type parameters object to a JsonNode using runtime reflection.
    /// This avoids System.Text.Json's reflection-based serializer which is disabled in .NET 9 trimmed apps.
    /// </summary>
    private static JsonNode? ToJsonNode(object? value)
    {
        if (value == null) return null;
        if (value is JsonNode jn) return jn;
        if (value is JsonElement je) return JsonNode.Parse(je.GetRawText());

        var type = value.GetType();
        // Handle primitives directly
        if (value is string s) return JsonValue.Create(s);
        if (value is bool b) return JsonValue.Create(b);
        if (value is int i) return JsonValue.Create(i);
        if (value is long l) return JsonValue.Create(l);
        if (value is double d) return JsonValue.Create(d);
        if (value is float f) return JsonValue.Create(f);

        // Anonymous types / POCOs: enumerate properties via CLR reflection
        var obj = new JsonObject();
        foreach (var prop in type.GetProperties())
        {
            if (!prop.CanRead) continue;
            var propValue = prop.GetValue(value);
            obj[prop.Name] = ToJsonNode(propValue);
        }
        return obj;
    }

    // ── Convenience methods ────────────────────────────────────

    public async Task<List<CdpTargetInfo>> GetPageTargetsAsync(CancellationToken ct = default)
    {
        var result = await SendCommandAsync("Target.getTargets", null, null, ct);
        var targets = result.GetProperty("targetInfos");
        var list = new List<CdpTargetInfo>();
        foreach (var t in targets.EnumerateArray())
        {
            var type = t.GetProperty("type").GetString();
            if (type == "page")
                list.Add(new CdpTargetInfo
                {
                    Id = t.GetProperty("targetId").GetString()!,
                    Title = t.GetProperty("title").GetString() ?? "",
                    Url = t.GetProperty("url").GetString() ?? "",
                    Type = type!
                });
        }
        return list;
    }

    public async Task<CdpTargetInfo?> GetActiveTabAsync(CancellationToken ct = default)
    {
        var targets = await GetPageTargetsAsync(ct);
        return targets.FirstOrDefault(t => t.Url.Contains("x.com")) ?? targets.FirstOrDefault();
    }

    public async Task ActivateTargetAsync(string targetId, CancellationToken ct = default)
    {
        await SendCommandAsync("Target.activateTarget", new { targetId }, null, ct);
    }

    public async Task<string> AttachToTargetAsync(string targetId, CancellationToken ct = default)
    {
        var result = await SendCommandAsync("Target.attachToTarget",
            new { targetId, flatten = true }, null, ct);
        return result.GetProperty("sessionId").GetString()!;
    }

    public async Task DetachFromTargetAsync(string sessionId, CancellationToken ct = default)
    {
        try { await SendCommandAsync("Target.detachFromTarget", new { sessionId }, null, ct); }
        catch { /* ignore */ }
    }

    public async Task NavigatePageAsync(string sessionId, string url, CancellationToken ct = default)
    {
        await SendCommandAsync("Page.navigate", new { url }, sessionId, ct);
    }

    public async Task WaitForPageLoadAsync(string sessionId, int timeoutMs = 15000, CancellationToken ct = default)
    {
        var escaped = "(function(){return document.readyState})()";
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);
        while (!cts.IsCancellationRequested)
        {
            var result = await EvaluateAsync(sessionId, escaped, cts.Token);
            if (result.GetString() == "complete") return;
            await Task.Delay(500, cts.Token);
        }
        throw new CdpException("Page load timeout");
    }

    public async Task WaitForSelectorAsync(string sessionId, string selector, int timeoutMs = 30000, CancellationToken ct = default)
    {
        var escaped = selector.Replace("'", "\\'");
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeoutMs);
        while (!cts.IsCancellationRequested)
        {
            var result = await EvaluateAsync(sessionId,
                $"document.querySelectorAll('{escaped}').length", cts.Token);
            if (result.GetInt32() > 0) return;
            await Task.Delay(800, cts.Token);
        }
        throw new CdpException($"Selector timeout: {selector}");
    }

    public async Task<string> OpenNewTabAsync(string url, CancellationToken ct = default)
    {
        var createResult = await SendCommandAsync("Target.createTarget", new { url }, null, ct);
        var targetId = createResult.GetProperty("targetId").GetString()!;
        return await AttachToTargetAsync(targetId, ct);
    }

    public async Task<JsonElement> EvaluateAsync(string sessionId, string expression, CancellationToken ct = default)
    {
        var result = await SendCommandAsync("Runtime.evaluate", new
        {
            expression,
            returnByValue = true,
            awaitPromise = true
        }, sessionId, ct);

        if (result.TryGetProperty("exceptionDetails", out var ex))
            throw new CdpException($"Eval error: {ex}");

        if (result.TryGetProperty("result", out var evalResult) &&
            evalResult.TryGetProperty("value", out var value))
            return value;

        // Expression returned no value (e.g. void call or undefined)
        return default;
    }

    public async Task<JsonElement> ClickElementAsync(string sessionId, string selector, CancellationToken ct = default)
    {
        var escaped = selector.Replace("'", "\\'");
        var js = $"(function(){{var el=document.querySelector('{escaped}');if(!el)return{{found:false}};el.scrollIntoView({{block:'center'}});el.click();return{{found:true}}}})()";
        return await EvaluateAsync(sessionId, js, ct);
    }
}
