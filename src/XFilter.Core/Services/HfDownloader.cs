using System.Text.Json;

namespace XFilter.Core.Services;

public class DownloadProgress
{
    public string Type { get; set; } = "";   // "status" or "progress"
    public string? Text { get; set; }
    public string? File { get; set; }
    public long Downloaded { get; set; }
    public long Total { get; set; }
    public int Percent { get; set; }
}

public class HfFile
{
    public string Name { get; set; } = "";
    public long Size { get; set; }
}

public interface IHfDownloader
{
    Task<List<HfFile>> ListFilesAsync(string repo, CancellationToken ct = default);
    Task DownloadFileAsync(string repo, HfFile file, string outputDir,
        Action<DownloadProgress>? onProgress = null, CancellationToken ct = default);
    void Cancel();
}

public class HfDownloader : IHfDownloader
{
    private readonly HttpClient _http;
    private volatile bool _cancelled;

    public HfDownloader()
    {
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("x-filter/1.0");
    }

    public void Cancel() => _cancelled = true;

    public async Task<List<HfFile>> ListFilesAsync(string repo, CancellationToken ct = default)
    {
        _cancelled = false;
        var repoId = string.IsNullOrEmpty(repo) ? "coke123/x-spam-classifier" : repo;
        var url = $"https://huggingface.co/api/models/{repoId}";
        var response = await _http.GetAsync(url, ct);
        response.EnsureSuccessStatusCode();
        var json = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(json);
        var siblings = doc.RootElement.GetProperty("siblings");
        return siblings.EnumerateArray()
            .Select(s => new HfFile
            {
                Name = s.GetProperty("rfilename").GetString()!,
                Size = s.TryGetProperty("size", out var sz) ? sz.GetInt64() : 0
            }).ToList();
    }

    public async Task DownloadFileAsync(string repo, HfFile file, string outputDir,
        Action<DownloadProgress>? onProgress = null, CancellationToken ct = default)
    {
        var url = $"https://huggingface.co/{repo}/resolve/main/{file.Name}";
        var dest = Path.Combine(outputDir, file.Name);
        var destDir = Path.GetDirectoryName(dest)!;
        Directory.CreateDirectory(destDir);

        var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        await using var fs = File.Create(dest);
        var buffer = new byte[81920];
        long downloaded = 0;

        int read;
        while ((read = await stream.ReadAsync(buffer, ct)) > 0)
        {
            if (_cancelled) throw new OperationCanceledException();
            await fs.WriteAsync(buffer.AsMemory(0, read), ct);
            downloaded += read;

            var pct = file.Size > 0
                ? (int)Math.Round((double)downloaded / file.Size * 100)
                : 0;

            onProgress?.Invoke(new DownloadProgress
            {
                Type = "progress",
                File = file.Name,
                Downloaded = downloaded,
                Total = file.Size,
                Percent = pct
            });
        }
    }
}
