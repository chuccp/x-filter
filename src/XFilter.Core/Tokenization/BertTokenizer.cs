using System.Text;

namespace XFilter.Core.Tokenization;

public interface IBertTokenizer
{
    BertEncoding Encode(string text, int maxLength = 512);
    BertEncoding EncodePair(string textA, string textB, int maxLength = 512);
}

public class BertEncoding
{
    public long[] InputIds { get; set; } = [];
    public long[] AttentionMask { get; set; } = [];
    public long[] TokenTypeIds { get; set; } = [];
}

/// <summary>
/// WordPiece tokenizer for BERT multilingual-cased model.
/// Loads vocab.txt directly — no external dependency.
/// </summary>
public class BertTokenizer : IBertTokenizer
{
    private readonly Dictionary<string, int> _vocab = new();
    private readonly List<string> _idToToken = new();
    private readonly bool _doLowerCase;

    private const int CLS_ID = 101;  // [CLS]
    private const int SEP_ID = 102;  // [SEP]
    private const int PAD_ID = 0;    // [PAD]
    private const int UNK_ID = 100;  // [UNK]
    private const int MAX_INPUT_CHARS = 100;

    public BertTokenizer(string modelDir, bool doLowerCase = false)
    {
        _doLowerCase = doLowerCase;
        var vocabPath = Path.Combine(modelDir, "vocab.txt");
        if (!File.Exists(vocabPath))
            throw new FileNotFoundException($"vocab.txt not found at {vocabPath}");

        var lines = File.ReadAllLines(vocabPath);
        for (var i = 0; i < lines.Length; i++)
        {
            var token = lines[i].Trim();
            _vocab[token] = i;
            _idToToken.Add(token);
        }
    }

    public BertEncoding Encode(string text, int maxLength = 512)
        => EncodePair(null, text, maxLength);

    public BertEncoding EncodePair(string? textA, string textB, int maxLength = 512)
    {
        var tokens = new List<string> { "[CLS]" };

        var segALen = 0;
        if (!string.IsNullOrEmpty(textA))
        {
            TokenizeText(textA, tokens);
            tokens.Add("[SEP]");
            segALen = tokens.Count;
        }

        TokenizeText(textB ?? "", tokens);
        tokens.Add("[SEP]");

        // Truncate
        if (tokens.Count > maxLength)
            tokens = tokens.Take(maxLength - 1).Append("[SEP]").ToList();

        var inputIds = tokens.Select(t => _vocab.TryGetValue(t, out var id) ? (long)id : UNK_ID).ToArray();
        var attentionMask = Enumerable.Repeat(1L, inputIds.Length).ToArray();
        var tokenTypeIds = inputIds.Select((_, i) => segALen > 0 && i >= segALen ? 1L : 0L).ToArray();

        // Pad to maxLength
        if (inputIds.Length < maxLength)
        {
            inputIds = inputIds.Concat(Enumerable.Repeat((long)PAD_ID, maxLength - inputIds.Length)).ToArray();
            attentionMask = attentionMask.Concat(Enumerable.Repeat(0L, maxLength - attentionMask.Length)).ToArray();
            tokenTypeIds = tokenTypeIds.Concat(Enumerable.Repeat(0L, maxLength - tokenTypeIds.Length)).ToArray();
        }

        return new BertEncoding
        {
            InputIds = inputIds,
            AttentionMask = attentionMask,
            TokenTypeIds = tokenTypeIds,
        };
    }

    private void TokenizeText(string text, List<string> tokens)
    {
        if (_doLowerCase) text = text.ToLowerInvariant();

        var chars = text.ToCharArray();
        var start = 0;
        while (start < chars.Length)
        {
            var end = Math.Min(start + MAX_INPUT_CHARS, chars.Length);
            var sub = new string(chars, start, end - start);
            var subTokens = BasicTokenize(sub);
            foreach (var t in subTokens)
            {
                // Split CJK characters into individual tokens
                var cjkSplit = SplitCjk(t);
                foreach (var ct in cjkSplit)
                    tokens.AddRange(WordPieceTokenize(ct));
            }
            start = end;
        }
    }

    // Split CJK characters — BERT multilingual tokenizer requires
    // Chinese/Japanese/Korean characters to be individual tokens
    private static List<string> SplitCjk(string token)
    {
        var result = new List<string>();
        var buf = new System.Text.StringBuilder();
        foreach (var ch in token)
        {
            if (IsCjk(ch))
            {
                if (buf.Length > 0) { result.Add(buf.ToString()); buf.Clear(); }
                result.Add(ch.ToString());
            }
            else buf.Append(ch);
        }
        if (buf.Length > 0) result.Add(buf.ToString());
        return result.Count == 0 ? new List<string> { token } : result;
    }

    private static bool IsCjk(char c) =>
        (c >= 0x4E00 && c <= 0x9FFF) ||   // CJK Unified Ideographs
        (c >= 0x3400 && c <= 0x4DBF) ||   // CJK Extension A
        (c >= 0x3000 && c <= 0x303F) ||   // CJK Symbols
        (c >= 0xFF00 && c <= 0xFFEF) ||   // Halfwidth/Fullwidth
        (c >= 0x3040 && c <= 0x309F) ||   // Hiragana
        (c >= 0x30A0 && c <= 0x30FF);     // Katakana

    private List<string> BasicTokenize(string text)
    {
        // Split on whitespace and punctuation
        var tokens = new List<string>();
        var current = new StringBuilder();

        foreach (var c in text)
        {
            if (char.IsWhiteSpace(c))
            {
                if (current.Length > 0) { tokens.Add(current.ToString()); current.Clear(); }
            }
            else if (IsPunctuation(c))
            {
                if (current.Length > 0) { tokens.Add(current.ToString()); current.Clear(); }
                tokens.Add(c.ToString());
            }
            else
            {
                current.Append(c);
            }
        }
        if (current.Length > 0) tokens.Add(current.ToString());

        return tokens;
    }

    private List<string> WordPieceTokenize(string token)
    {
        if (token.Length > MAX_INPUT_CHARS)
            token = token[..MAX_INPUT_CHARS];

        var subTokens = new List<string>();
        var isBad = false;
        var start = 0;

        while (start < token.Length)
        {
            var end = token.Length;
            var curSubstr = "";
            var found = false;

            while (start < end)
            {
                var substr = (start > 0 ? "##" : "") + token[start..end];
                if (_vocab.ContainsKey(substr))
                {
                    curSubstr = substr;
                    found = true;
                    break;
                }
                end--;
            }

            if (!found)
            {
                isBad = true;
                break;
            }

            subTokens.Add(curSubstr);
            start = end;
        }

        return isBad ? new List<string> { "[UNK]" } : subTokens;
    }

    private static bool IsPunctuation(char c) =>
        char.IsPunctuation(c) || char.IsSymbol(c) || c is '[' or ']' or '{' or '}' or '(' or ')';
}
