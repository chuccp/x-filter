using System.Collections.ObjectModel;
using System.Text;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Data;
using XFilter.Core.Models;

namespace XFilter.UI.ViewModels;

public partial class DataViewModel : ViewModelBase
{
    private readonly IDatabaseService _db;

    [ObservableProperty] private string _filter = "all";
    [ObservableProperty] private string _statsText = "";
    [ObservableProperty] private bool _isEmpty;

    public ObservableCollection<Comment> Comments { get; } = new();

    public DataViewModel(IDatabaseService db) { _db = db; Load(); }

    [RelayCommand]
    public void Load()
    {
        var s = _db.GetLabelStats();
        StatsText = T("export.stats", new()
        {
            ["spam"] = s.Spam.ToString(),
            ["not_spam"] = s.NotSpam.ToString(),
            ["labeled"] = (s.Spam + s.NotSpam).ToString(),
            ["total"] = s.Total.ToString()
        });

        var list = _db.GetAllComments(Filter, 500, 0).Where(c => c.Label.HasValue).ToList();
        Comments.Clear();
        foreach (var c in list) Comments.Add(c);
        IsEmpty = Comments.Count == 0;
    }

    [RelayCommand] private void SetFilter(string f) { Filter = f; Load(); }

    [RelayCommand]
    private void CopyCsv()
    {
        var rows = _db.ExportLabeledComments();
        var sb = new StringBuilder();
        sb.AppendLine("text,post_text,label");
        foreach (var r in rows)
            sb.AppendLine($"\"{Escape(r.Text)}\",\"{Escape(r.PostText ?? "")}\",{r.Label}");
        System.Diagnostics.Debug.WriteLine(sb.ToString());
    }

    private static string Escape(string? s) => (s ?? "").Replace("\"", "\"\"");
}
