using System.Text.RegularExpressions;

namespace XFilter.Core.Tokenization;

public static class EmojiHelper
{
    // Strip emoji, symbols, and other non-vocab characters for BERT tokenization.
    // Uses a manually compiled regex since .NET GeneratedRegex has issues with
    // high-surrogate Unicode escapes.
    private static readonly Regex _emojiRegex = new(
        @"[‼⁉™ℹ↔-↙↩↪⌚⌛⌨⏏⏩-⏳⏸-⏺Ⓜ▪▫▶◀◻-◾☀-➿⤴⤵⬅-⬇⬛⬜⭐⭕〰〽㊗㊙" +
        "🀀-🀯" +   // U+1F000-U+1F02F
        "🀰-🁏" +   // ... (approximate)
        "🁐-🏿" +   // misc symbols
        "🐀-🙏" +   // U+1F100-U+1F64F (core emoji)
        "🚀-🛿" +   // U+1F680-U+1F6FF
        "🤐-🥫" +   // U+1F910-U+1F96B
        "🦀-🧠" +   // U+1F980-U+1F9E0
        "]",
        RegexOptions.Compiled);

    /// <summary>
    /// Replace emoji characters with a space.
    /// Port of node-emoji's unemojify() behavior.
    /// </summary>
    public static string Demojize(string input)
    {
        if (string.IsNullOrEmpty(input)) return input;
        return _emojiRegex.Replace(input, " ");
    }
}
