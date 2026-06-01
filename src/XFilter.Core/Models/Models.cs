namespace XFilter.Core.Models;

public class Comment
{
    public long Id { get; set; }
    public string Text { get; set; } = "";
    public string Username { get; set; } = "";
    public string SourceUrl { get; set; } = "";
    public string TextHash { get; set; } = "";
    public string? PostText { get; set; }
    public int? Label { get; set; }
    public string? LabeledAt { get; set; }
    public double? ModelPrediction { get; set; }
    public string? CollectedAt { get; set; }
}

public class BlockedUser
{
    public long Id { get; set; }
    public string Username { get; set; } = "";
    public string? BlockedAt { get; set; }
    public long? SourceCommentId { get; set; }
    public string? BlockReason { get; set; }
    public string? ProfileUrl { get; set; }
}

public class ScrapeSession
{
    public long Id { get; set; }
    public string SourceUrl { get; set; } = "";
    public string? StartedAt { get; set; }
    public string? CompletedAt { get; set; }
    public int CommentsFound { get; set; }
    public string Status { get; set; } = "in_progress";
}

public class BlockSession
{
    public long Id { get; set; }
    public string SourceUrl { get; set; } = "";
    public string? StartedAt { get; set; }
    public string? CompletedAt { get; set; }
    public int CommentsScanned { get; set; }
    public int SpamDetected { get; set; }
    public int UsersBlocked { get; set; }
    public int Errors { get; set; }
    public string Status { get; set; } = "in_progress";
}

public class AppSetting
{
    public string Key { get; set; } = "";
    public string? Value { get; set; }
}

public class BlocklistEntry
{
    public long Id { get; set; }
    public string Username { get; set; } = "";
    public string? AddedAt { get; set; }
    public int IsBlocked { get; set; }
}

public class LabelStats
{
    public long Total { get; set; }
    public long Spam { get; set; }
    public long NotSpam { get; set; }
    public long Unlabeled { get; set; }
}

public class ModelStatus
{
    public bool Loaded { get; set; }
    public string? Error { get; set; }
    public ModelMetrics? Metrics { get; set; }
    public string? Path { get; set; }
}

public class ModelMetrics
{
    public double EvalF1 { get; set; }
    public double EvalAccuracy { get; set; }
    public double EvalPrecision { get; set; }
    public double EvalRecall { get; set; }
}

public class PredictionResult
{
    public bool Spam { get; set; }
    public float Confidence { get; set; }
}

public class ScrapedComment
{
    public string Text { get; set; } = "";
    public string Username { get; set; } = "";
    public string PostText { get; set; } = "";
    public string SourceUrl { get; set; } = "";
}

public class CdpTargetInfo
{
    public string Id { get; set; } = "";
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
    public string Type { get; set; } = "";
}
