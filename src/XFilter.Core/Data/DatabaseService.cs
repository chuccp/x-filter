using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using XFilter.Core.Models;

namespace XFilter.Core.Data;

public interface IDatabaseService
{
    void Initialize();
    // Comments
    int InsertComments(List<ScrapedComment> comments);
    List<Comment> GetUnlabeledComments(int limit = 20, int offset = 0);
    List<Comment> GetLabeledComments();
    List<Comment> GetAllComments(string filter = "all", int limit = 50, int offset = 0);
    void SetLabel(long id, int label);
    void BatchSetLabel(long[] ids, int label);
    bool DeleteComment(long id);
    LabelStats GetLabelStats();
    List<Comment> ExportLabeledComments();
    // Blocked users
    bool IsUserBlocked(string username);
    void AddBlockedUser(string username, long? commentId = null, string? reason = null);
    List<BlockedUser> GetBlockedUsers();
    // Sessions
    long CreateScrapeSession(string sourceUrl);
    void CompleteScrapeSession(long id, int commentsFound);
    void FailScrapeSession(long id);
    long CreateBlockSession(string sourceUrl);
    void CompleteBlockSession(long id, int scanned, int spam, int blocked, int errors);
    // Settings
    string? GetSetting(string key);
    void SetSetting(string key, string value);
    Dictionary<string, string> GetAllSettings();
    // Blocklist
    List<BlocklistEntry> GetBlocklist();
    bool AddToBlocklist(string username);
    bool RemoveFromBlocklist(string username);
    void ClearBlocklist();
    int ImportBlocklist(IEnumerable<string> usernames);
    bool IsInBlocklist(string username);
    void MarkBlockedInBlocklist(string username);
    void MarkMultipleBlockedInBlocklist(IEnumerable<string> usernames);
}

public class DatabaseService : IDatabaseService
{
    private readonly string _dbPath;

    public DatabaseService()
    {
        var dataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "x-filter", "data");
        Directory.CreateDirectory(dataDir);
        _dbPath = Path.Combine(dataDir, "x-filter.db");
        Initialize();
    }

    private SqliteConnection CreateConnection()
    {
        var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;";
        cmd.ExecuteNonQuery();
        return conn;
    }

    public void Initialize()
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                username TEXT NOT NULL,
                source_url TEXT NOT NULL,
                text_hash TEXT UNIQUE NOT NULL,
                post_text TEXT,
                label INTEGER,
                labeled_at TEXT,
                model_prediction REAL,
                collected_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS blocked_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                blocked_at TEXT DEFAULT (datetime('now')),
                source_comment_id INTEGER REFERENCES comments(id),
                block_reason TEXT,
                profile_url TEXT
            );
            CREATE TABLE IF NOT EXISTS scrape_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_url TEXT NOT NULL,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                comments_found INTEGER DEFAULT 0,
                status TEXT DEFAULT 'in_progress'
            );
            CREATE TABLE IF NOT EXISTS block_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_url TEXT NOT NULL,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                comments_scanned INTEGER DEFAULT 0,
                spam_detected INTEGER DEFAULT 0,
                users_blocked INTEGER DEFAULT 0,
                errors INTEGER DEFAULT 0,
                status TEXT DEFAULT 'in_progress'
            );
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS blocklist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                added_at TEXT DEFAULT (datetime('now')),
                is_blocked INTEGER DEFAULT 0
            );";
        cmd.ExecuteNonQuery();

        // Default settings
        cmd.CommandText = @"
            INSERT OR IGNORE INTO app_settings (key, value) VALUES
            ('spam_threshold', '0.8'),
            ('max_scroll', '50'),
            ('scroll_delay', '1500'),
            ('language', 'zh-CN');";
        cmd.ExecuteNonQuery();

        // Migrations (safe to run)
        var migrations = new[]
        {
            "ALTER TABLE comments ADD COLUMN post_text TEXT",
            "ALTER TABLE blocklist ADD COLUMN is_blocked INTEGER DEFAULT 0",
            "ALTER TABLE blocked_users ADD COLUMN block_reason TEXT",
            "ALTER TABLE blocked_users ADD COLUMN profile_url TEXT",
        };
        foreach (var m in migrations)
        {
            try { using var mc = conn.CreateCommand(); mc.CommandText = m; mc.ExecuteNonQuery(); }
            catch { /* column already exists */ }
        }
    }

    // ── Comments ────────────────────────────────────────────────

    public int InsertComments(List<ScrapedComment> comments)
    {
        var count = 0;
        using var conn = CreateConnection();
        using var tx = conn.BeginTransaction();
        foreach (var c in comments)
        {
            try
            {
                using var cmd = conn.CreateCommand();
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(c.Text))).ToLowerInvariant();
                cmd.CommandText = "INSERT OR IGNORE INTO comments (text, username, source_url, text_hash, post_text) VALUES (@t, @u, @s, @h, @p)";
                cmd.Parameters.AddWithValue("@t", c.Text);
                cmd.Parameters.AddWithValue("@u", c.Username);
                cmd.Parameters.AddWithValue("@s", (object?)c.SourceUrl ?? "");
                cmd.Parameters.AddWithValue("@h", hash);
                cmd.Parameters.AddWithValue("@p", (object?)c.PostText ?? DBNull.Value);
                if (cmd.ExecuteNonQuery() > 0) count++;
            }
            catch { /* duplicate */ }
        }
        tx.Commit();
        return count;
    }

    public List<Comment> GetUnlabeledComments(int limit = 20, int offset = 0)
    {
        var results = new List<Comment>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM comments WHERE label IS NULL ORDER BY id LIMIT @l OFFSET @o";
        cmd.Parameters.AddWithValue("@l", limit);
        cmd.Parameters.AddWithValue("@o", offset);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) results.Add(ReadComment(reader));
        return results;
    }

    public List<Comment> GetLabeledComments()
    {
        var results = new List<Comment>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM comments WHERE label IS NOT NULL ORDER BY labeled_at DESC";
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) results.Add(ReadComment(reader));
        return results;
    }

    public List<Comment> GetAllComments(string filter = "all", int limit = 50, int offset = 0)
    {
        var results = new List<Comment>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = filter switch
        {
            "spam" => "SELECT * FROM comments WHERE label = 1 ORDER BY id DESC LIMIT @l OFFSET @o",
            "not-spam" => "SELECT * FROM comments WHERE label = 0 ORDER BY id DESC LIMIT @l OFFSET @o",
            "unlabeled" => "SELECT * FROM comments WHERE label IS NULL ORDER BY id LIMIT @l OFFSET @o",
            _ => "SELECT * FROM comments ORDER BY id DESC LIMIT @l OFFSET @o",
        };
        cmd.Parameters.AddWithValue("@l", limit);
        cmd.Parameters.AddWithValue("@o", offset);
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) results.Add(ReadComment(reader));
        return results;
    }

    public void SetLabel(long id, int label)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE comments SET label = @l, labeled_at = datetime('now') WHERE id = @id";
        cmd.Parameters.AddWithValue("@l", label);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public void BatchSetLabel(long[] ids, int label)
    {
        using var conn = CreateConnection();
        using var tx = conn.BeginTransaction();
        foreach (var id in ids)
        {
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "UPDATE comments SET label = @l, labeled_at = datetime('now') WHERE id = @id";
            cmd.Parameters.AddWithValue("@l", label);
            cmd.Parameters.AddWithValue("@id", id);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    public bool DeleteComment(long id)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM comments WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        return cmd.ExecuteNonQuery() > 0;
    }

    public LabelStats GetLabelStats()
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"SELECT
            COUNT(*) as total,
            SUM(CASE WHEN label = 1 THEN 1 ELSE 0 END) as spam,
            SUM(CASE WHEN label = 0 THEN 1 ELSE 0 END) as not_spam,
            SUM(CASE WHEN label IS NULL THEN 1 ELSE 0 END) as unlabeled
            FROM comments";
        using var reader = cmd.ExecuteReader();
        if (reader.Read())
            return new LabelStats
            {
                Total = reader.GetInt64(0),
                Spam = reader.GetInt64(1),
                NotSpam = reader.GetInt64(2),
                Unlabeled = reader.GetInt64(3),
            };
        return new LabelStats();
    }

    public List<Comment> ExportLabeledComments()
    {
        var results = new List<Comment>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT text, username, label, post_text FROM comments WHERE label IS NOT NULL";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            results.Add(new Comment
            {
                Text = reader.GetString(0),
                Username = reader.GetString(1),
                Label = reader.GetInt32(2),
                PostText = reader.IsDBNull(3) ? null : reader.GetString(3),
            });
        return results;
    }

    // ── Blocked Users ──────────────────────────────────────────

    public bool IsUserBlocked(string username)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id FROM blocked_users WHERE username = @u";
        cmd.Parameters.AddWithValue("@u", username);
        using var reader = cmd.ExecuteReader();
        return reader.Read();
    }

    public void AddBlockedUser(string username, long? commentId = null, string? reason = null)
    {
        var profileUrl = $"https://x.com/{username}";
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO blocked_users (username, source_comment_id, block_reason, profile_url) VALUES (@u, @c, @r, @p)";
        cmd.Parameters.AddWithValue("@u", username);
        cmd.Parameters.AddWithValue("@c", (object?)commentId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@r", (object?)reason ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@p", profileUrl);
        cmd.ExecuteNonQuery();
    }

    public List<BlockedUser> GetBlockedUsers()
    {
        var results = new List<BlockedUser>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM blocked_users ORDER BY blocked_at DESC";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            results.Add(new BlockedUser
            {
                Id = reader.GetInt64(0),
                Username = reader.GetString(1),
                BlockedAt = reader.IsDBNull(2) ? null : reader.GetString(2),
                SourceCommentId = reader.IsDBNull(3) ? null : reader.GetInt64(3),
                BlockReason = reader.IsDBNull(4) ? null : reader.GetString(4),
                ProfileUrl = reader.IsDBNull(5) ? null : reader.GetString(5),
            });
        return results;
    }

    // ── Sessions ────────────────────────────────────────────────

    public long CreateScrapeSession(string sourceUrl)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT INTO scrape_sessions (source_url) VALUES (@u); SELECT last_insert_rowid();";
        cmd.Parameters.AddWithValue("@u", sourceUrl);
        return (long)cmd.ExecuteScalar()!;
    }

    public void CompleteScrapeSession(long id, int commentsFound)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE scrape_sessions SET completed_at = datetime('now'), comments_found = @c, status = 'completed' WHERE id = @id";
        cmd.Parameters.AddWithValue("@c", commentsFound);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public void FailScrapeSession(long id)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE scrape_sessions SET completed_at = datetime('now'), status = 'error' WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public long CreateBlockSession(string sourceUrl)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT INTO block_sessions (source_url) VALUES (@u); SELECT last_insert_rowid();";
        cmd.Parameters.AddWithValue("@u", sourceUrl);
        return (long)cmd.ExecuteScalar()!;
    }

    public void CompleteBlockSession(long id, int scanned, int spam, int blocked, int errors)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"UPDATE block_sessions SET completed_at = datetime('now'),
            comments_scanned = @s, spam_detected = @sp, users_blocked = @b, errors = @e, status = 'completed'
            WHERE id = @id";
        cmd.Parameters.AddWithValue("@s", scanned);
        cmd.Parameters.AddWithValue("@sp", spam);
        cmd.Parameters.AddWithValue("@b", blocked);
        cmd.Parameters.AddWithValue("@e", errors);
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    // ── Settings ───────────────────────────────────────────────

    public string? GetSetting(string key)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM app_settings WHERE key = @k";
        cmd.Parameters.AddWithValue("@k", key);
        return cmd.ExecuteScalar() as string;
    }

    public void SetSetting(string key, string value)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR REPLACE INTO app_settings (key, value) VALUES (@k, @v)";
        cmd.Parameters.AddWithValue("@k", key);
        cmd.Parameters.AddWithValue("@v", value);
        cmd.ExecuteNonQuery();
    }

    public Dictionary<string, string> GetAllSettings()
    {
        var settings = new Dictionary<string, string>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM app_settings";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            settings[reader.GetString(0)] = reader.IsDBNull(1) ? "" : reader.GetString(1);
        return settings;
    }

    // ── Blocklist ──────────────────────────────────────────────

    public List<BlocklistEntry> GetBlocklist()
    {
        var results = new List<BlocklistEntry>();
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM blocklist ORDER BY added_at DESC";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            results.Add(new BlocklistEntry
            {
                Id = reader.GetInt64(0),
                Username = reader.GetString(1),
                AddedAt = reader.IsDBNull(2) ? null : reader.GetString(2),
                IsBlocked = reader.GetInt32(3),
            });
        return results;
    }

    public bool AddToBlocklist(string username)
    {
        var u = username.TrimStart('@').Trim();
        if (string.IsNullOrEmpty(u)) return false;
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO blocklist (username) VALUES (@u)";
        cmd.Parameters.AddWithValue("@u", u);
        return cmd.ExecuteNonQuery() > 0;
    }

    public bool RemoveFromBlocklist(string username)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM blocklist WHERE username = @u";
        cmd.Parameters.AddWithValue("@u", username);
        return cmd.ExecuteNonQuery() > 0;
    }

    public void ClearBlocklist()
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM blocklist";
        cmd.ExecuteNonQuery();
    }

    public int ImportBlocklist(IEnumerable<string> usernames)
    {
        var count = 0;
        using var conn = CreateConnection();
        using var tx = conn.BeginTransaction();
        foreach (var raw in usernames)
        {
            var u = raw.TrimStart('@').Trim();
            if (string.IsNullOrEmpty(u)) continue;
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "INSERT OR IGNORE INTO blocklist (username) VALUES (@u)";
            cmd.Parameters.AddWithValue("@u", u);
            if (cmd.ExecuteNonQuery() > 0) count++;
        }
        tx.Commit();
        return count;
    }

    public bool IsInBlocklist(string username)
    {
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT id FROM blocklist WHERE username = @u";
        cmd.Parameters.AddWithValue("@u", username);
        using var reader = cmd.ExecuteReader();
        return reader.Read();
    }

    public void MarkBlockedInBlocklist(string username)
    {
        var u = username.TrimStart('@').Trim();
        if (string.IsNullOrEmpty(u)) return;
        using var conn = CreateConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            INSERT OR IGNORE INTO blocklist (username, is_blocked) VALUES (@u, 1);
            UPDATE blocklist SET is_blocked = 1 WHERE username = @u;";
        cmd.Parameters.AddWithValue("@u", u);
        cmd.ExecuteNonQuery();
    }

    public void MarkMultipleBlockedInBlocklist(IEnumerable<string> usernames)
    {
        using var conn = CreateConnection();
        using var tx = conn.BeginTransaction();
        foreach (var raw in usernames)
        {
            var u = raw.TrimStart('@').Trim();
            if (string.IsNullOrEmpty(u)) continue;
            using var cmd = conn.CreateCommand();
            cmd.CommandText = @"
                INSERT OR IGNORE INTO blocklist (username, is_blocked) VALUES (@u, 1);
                UPDATE blocklist SET is_blocked = 1 WHERE username = @u;";
            cmd.Parameters.AddWithValue("@u", u);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
    }

    // ── Helpers ────────────────────────────────────────────────

    private static Comment ReadComment(SqliteDataReader reader)
        => new()
        {
            Id = reader.GetInt64(0),
            Text = reader.GetString(1),
            Username = reader.GetString(2),
            SourceUrl = reader.GetString(3),
            TextHash = reader.GetString(4),
            PostText = reader.IsDBNull(5) ? null : reader.GetString(5),
            Label = reader.IsDBNull(6) ? null : reader.GetInt32(6),
            LabeledAt = reader.IsDBNull(7) ? null : reader.GetString(7),
            ModelPrediction = reader.IsDBNull(8) ? null : reader.GetDouble(8),
            CollectedAt = reader.IsDBNull(9) ? null : reader.GetString(9),
        };
}
