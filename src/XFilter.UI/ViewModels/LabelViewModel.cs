using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Data;
using XFilter.Core.Models;

namespace XFilter.UI.ViewModels;

public partial class LabelViewModel : ViewModelBase
{
    private readonly IDatabaseService _db;
    private List<Comment> _comments = new();
    private int _index;

    [ObservableProperty] private string _filter = "unlabeled";
    [ObservableProperty] private string _commentText = "";
    [ObservableProperty] private string _commentUser = "";
    [ObservableProperty] private string _postText = "";
    [ObservableProperty] private string _indexText = "";
    [ObservableProperty] private string _statsText = "";
    [ObservableProperty] private bool _hasComments;
    [ObservableProperty] private bool _isLabeled;

    public LabelViewModel(IDatabaseService db) { _db = db; Load(); }

    private void Load()
    {
        _comments = _db.GetAllComments(Filter, 200, 0);
        _index = 0; Refresh();
    }

    private void Refresh()
    {
        var s = _db.GetLabelStats();
        StatsText = T("label.stats_total") + $" {s.Total} | " +
                    T("label.stats_spam") + $" {s.Spam} | " +
                    T("label.stats_normal") + $" {s.NotSpam} | " +
                    T("label.stats_unlabeled") + $" {s.Unlabeled}";
        HasComments = _comments.Count > 0 && _index < _comments.Count;
        if (!HasComments) { CommentText = T("label.empty"); return; }
        var c = _comments[_index];
        CommentText = c.Text;
        CommentUser = $"@{c.Username}";
        PostText = string.IsNullOrEmpty(c.PostText) ? "" : c.PostText;
        IndexText = T("label.index", new()
        {
            ["current"] = (_index + 1).ToString(),
            ["total"] = _comments.Count.ToString()
        });
        IsLabeled = c.Label.HasValue;
    }

    [RelayCommand] private void Spam() => SetLabel(1);
    [RelayCommand] private void NotSpam() => SetLabel(0);

    private void SetLabel(int l)
    {
        if (!HasComments) return;
        _db.SetLabel(_comments[_index].Id, l);
        if (Filter == "unlabeled") { _comments.RemoveAt(_index); if (_index >= _comments.Count) _index = Math.Max(0, _comments.Count - 1); }
        else _comments[_index].Label = l;
        Refresh();
    }

    [RelayCommand] private void Delete()
    {
        if (!HasComments) return;
        _db.DeleteComment(_comments[_index].Id); _comments.RemoveAt(_index);
        if (_index >= _comments.Count) _index = Math.Max(0, _comments.Count - 1); Refresh();
    }

    [RelayCommand] private void Next() { if (_index < _comments.Count - 1) { _index++; Refresh(); } }
    [RelayCommand] private void Prev() { if (_index > 0) { _index--; Refresh(); } }

    [RelayCommand]
    private void SetFilter(string f) { Filter = f; Load(); }

    [RelayCommand]
    private void BatchSpam()
    {
        _db.BatchSetLabel(_comments.Select(c => c.Id).ToArray(), 1);
        if (Filter == "unlabeled") _comments.Clear(); Load();
    }

    [RelayCommand]
    private void BatchNotSpam()
    {
        _db.BatchSetLabel(_comments.Select(c => c.Id).ToArray(), 0);
        if (Filter == "unlabeled") _comments.Clear(); Load();
    }

    public void OnKeyDown(string key)
    {
        switch (key) { case "S": Spam(); break; case "N": NotSpam(); break; case "Delete": Delete(); break; }
    }
}
