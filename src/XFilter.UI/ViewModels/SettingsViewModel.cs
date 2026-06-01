using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Extensions.DependencyInjection;
using XFilter.Core.Data;
using XFilter.Core.I18n;
using XFilter.Core.Services;
using XFilter.UI.Views;

namespace XFilter.UI.ViewModels;

public partial class SettingsViewModel : ViewModelBase
{
    private readonly IDatabaseService _db;
    private readonly IModelService _model;
    private readonly IServiceProvider _services;

    [ObservableProperty] private int _maxScroll = 50;
    [ObservableProperty] private int _scrollDelay = 1500;
    [ObservableProperty] private double _spamThreshold = 0.8;
    [ObservableProperty] private string _modelInfo = "";
    [ObservableProperty] private string _saveStatus = "";
    [ObservableProperty] private string _downloadRepo = "coke123/x-spam-classifier";

    public SettingsViewModel(IDatabaseService db, IModelService model, IServiceProvider services)
    {
        _db = db; _model = model; _services = services;
        Load();
        RefreshModelInfo();

        var i18n = services.GetService(typeof(II18nService)) as II18nService;
        if (i18n != null)
            i18n.LanguageChanged += (_, _) =>
                Avalonia.Threading.Dispatcher.UIThread.Post(RefreshModelInfo);
    }

    private void Load()
    {
        var s = _db.GetAllSettings();
        if (s.TryGetValue("max_scroll", out var v)) MaxScroll = int.TryParse(v, out var x) ? x : 50;
        if (s.TryGetValue("scroll_delay", out v)) ScrollDelay = int.TryParse(v, out var x) ? x : 1500;
        if (s.TryGetValue("spam_threshold", out v)) SpamThreshold = double.TryParse(v, out var x) ? x : 0.8;
        RefreshModelInfo();
    }

    private void RefreshModelInfo()
    {
        var st = _model.GetStatus();
        ModelInfo = st.Loaded
            ? T("settings.model_loaded") + $" — F1: {st.Metrics?.EvalF1 ?? 0:F3}"
            : (st.Error ?? T("settings.model_not_loaded"));
    }

    [RelayCommand] private void Save()
    {
        _db.SetSetting("max_scroll", MaxScroll.ToString());
        _db.SetSetting("scroll_delay", ScrollDelay.ToString());
        _db.SetSetting("spam_threshold", SpamThreshold.ToString("F2"));
        SaveStatus = T("settings.saved");
    }

    [RelayCommand]
    private async Task LoadModel()
    {
        ModelInfo = T("settings.loading_model");
        var r = await _model.LoadModelAsync();
        ModelInfo = r.Loaded
            ? T("settings.model_loaded") + $" — F1: {r.Metrics?.EvalF1 ?? 0:F3}"
            : T("block.fail", new() { ["error"] = r.Error ?? "" });
    }

    [RelayCommand]
    private async Task DownloadModel()
    {
        if (string.IsNullOrWhiteSpace(DownloadRepo)) return;

        var downloadVm = _services.GetRequiredService<DownloadModelViewModel>();
        downloadVm.Repo = DownloadRepo;

        var window = new DownloadModelWindow { DataContext = downloadVm };
        var mainWindow = (Application.Current?.ApplicationLifetime as IClassicDesktopStyleApplicationLifetime)?.MainWindow;
        if (mainWindow != null)
            await window.ShowDialog(mainWindow);

        var st = _model.GetStatus();
        if (!st.Loaded && downloadVm.ModelLoaded)
            st = await _model.LoadModelAsync();

        ModelInfo = st.Loaded
            ? T("settings.model_loaded") + $" — F1: {st.Metrics?.EvalF1 ?? 0:F3}"
            : (st.Error ?? T("settings.model_not_loaded"));

        if (mainWindow?.DataContext is MainViewModel mainVm)
            mainVm.OnModelStatusChanged(st.Loaded, st.Metrics?.EvalF1.ToString("F3"));
    }
}
