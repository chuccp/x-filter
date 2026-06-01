using System.Text.Json;
using System.Text.RegularExpressions;

namespace XFilter.Core.I18n;

public interface II18nService
{
    string T(string key, Dictionary<string, string>? param = null);
    Task LoadLanguageAsync(string lang);
    IReadOnlyDictionary<string, string> GetTranslations();
    string CurrentLanguage { get; }
    event EventHandler? LanguageChanged;
}

public partial class I18nService : II18nService
{
    private Dictionary<string, string> _translations = new();
    public string CurrentLanguage { get; private set; } = "zh-CN";
    public event EventHandler? LanguageChanged;

    public string T(string key, Dictionary<string, string>? param = null)
    {
        if (!_translations.TryGetValue(key, out var text))
        {
            System.Diagnostics.Debug.WriteLine($"[i18n] Missing key: {key}");
            return key;
        }
        if (param != null)
        {
            text = MyRegex().Replace(text, m =>
                param.TryGetValue(m.Groups[1].Value, out var val) ? val : m.Value);
        }
        return text;
    }

    [GeneratedRegex("\\{\\{(\\w+)\\}\\}")]
    private static partial Regex MyRegex();

    private static Dictionary<string, string> ParseJson(string json)
    {
        var dict = new Dictionary<string, string>();
        using var doc = JsonDocument.Parse(json);
        foreach (var prop in doc.RootElement.EnumerateObject())
        {
            dict[prop.Name] = prop.Value.GetString() ?? "";
        }
        return dict;
    }

    public IReadOnlyDictionary<string, string> GetTranslations() => _translations;

    public async Task LoadLanguageAsync(string lang)
    {
        try
        {
            var assembly = typeof(I18nService).Assembly;
            var name = $"{assembly.GetName().Name}.Resources.I18n.{lang}.json";
            var stream = assembly.GetManifestResourceStream(name)
                      ?? assembly.GetManifestResourceStream($"{assembly.GetName().Name}.Resources.I18n.zh-CN.json");

            if (stream != null)
            {
                using var reader = new StreamReader(stream);
                var json = await reader.ReadToEndAsync();
                _translations = ParseJson(json);
            }

            CurrentLanguage = lang;
            LanguageChanged?.Invoke(this, EventArgs.Empty);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"[i18n] Failed to load language: {lang}, {ex.Message}");
        }
    }
}
