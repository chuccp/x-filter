using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.I18n;
using XFilter.Core.Services;

namespace XFilter.UI.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly IServiceProvider _services;

    [ObservableProperty] private ViewModelBase? _currentView;
    [ObservableProperty] private bool _isConnected;
    [ObservableProperty] private string _currentRole = "admin";
    [ObservableProperty] private string _modelInfoText = "";
    [ObservableProperty] private bool _isModelLoaded;

    // Sidebar labels (refreshed on language change)
    [ObservableProperty] private string _subtitleLabel = "";
    [ObservableProperty] private string _roleAdminLabel = "";
    [ObservableProperty] private string _roleUserLabel = "";

    public ObservableCollection<NavItem> NavItems { get; } = new();
    public ObservableCollection<LanguageItem> LanguageItems { get; } = new();

    public string Title => "x-filter — X Spam Filter";

    private readonly Dictionary<string, ViewModelBase> _viewCache = new();

    // Admin-only views
    private static readonly HashSet<string> AdminViews = new()
        { "collect", "label", "export", "train", "settings" };

    public MainViewModel(IServiceProvider services)
    {
        _services = services;
        BuildNavItems();
        BuildLanguageItems();
        RefreshSidebarLabels();
        NavigateCommand.Execute("connect");

        // Subscribe to language changes
        var i18n = _services.GetService(typeof(II18nService)) as II18nService;
        if (i18n != null)
        {
            i18n.LanguageChanged += (_, _) =>
                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    BuildNavItems();
                    BuildLanguageItems();
                    RefreshSidebarLabels();
                    // Force current view refresh
                    OnPropertyChanged(nameof(CurrentView));
                });
        }

        // Subscribe to CDP connection status
        var cdp = _services.GetService(typeof(ICdpClient)) as ICdpClient;
        if (cdp != null)
        {
            cdp.Disconnected += (_, _) =>
                Avalonia.Threading.Dispatcher.UIThread.Post(() => IsConnected = false);
        }

        // Initial model info
        ModelInfoText = T("block.model_checking");
    }

    private void BuildNavItems()
    {
        NavItems.Clear();
        NavItems.Add(new NavItem("⚡", T("nav.connect"), "connect", true));
        NavItems.Add(new NavItem("📥", T("nav.collect"), "collect", false));
        NavItems.Add(new NavItem("🏷", T("nav.label"), "label", false));
        NavItems.Add(new NavItem("📋", T("nav.data"), "export", false));
        NavItems.Add(new NavItem("🧠", T("nav.train"), "train", false));
        NavItems.Add(new NavItem("", "", "", true) { IsDivider = true });
        NavItems.Add(new NavItem("🛡", T("nav.block"), "block", true));
        NavItems.Add(new NavItem("📋", T("nav.blocklist"), "blocklist", true));
        NavItems.Add(new NavItem("⚙", T("nav.settings"), "settings", false));
    }

    private void BuildLanguageItems()
    {
        if (LanguageItems.Count == 0)
        {
            LanguageItems.Add(new LanguageItem("zh-CN", T("lang.zh_CN")));
            LanguageItems.Add(new LanguageItem("zh-TW", T("lang.zh_TW")));
            LanguageItems.Add(new LanguageItem("ja", T("lang.ja")));
            LanguageItems.Add(new LanguageItem("en", T("lang.en")));
        }
        else
        {
            // Update labels only — avoid Clear() which crashes ComboBox selection
            LanguageItems[0].Label = T("lang.zh_CN");
            LanguageItems[1].Label = T("lang.zh_TW");
            LanguageItems[2].Label = T("lang.ja");
            LanguageItems[3].Label = T("lang.en");
        }
    }

    private void RefreshSidebarLabels()
    {
        SubtitleLabel = T("app.subtitle");
        RoleAdminLabel = T("app.role_admin");
        RoleUserLabel = T("app.role_user");
    }

    [RelayCommand]
    private void Navigate(string viewName)
    {
        if (CurrentRole == "user" && AdminViews.Contains(viewName)) return;

        // Update active state
        foreach (var nav in NavItems)
            nav.IsActive = nav.ViewName == viewName;

        if (!_viewCache.TryGetValue(viewName, out var vm))
        {
            vm = viewName switch
            {
                "connect" => _services.GetService(typeof(ConnectViewModel)) as ViewModelBase,
                "collect" => _services.GetService(typeof(CollectViewModel)) as ViewModelBase,
                "label" => _services.GetService(typeof(LabelViewModel)) as ViewModelBase,
                "export" => _services.GetService(typeof(DataViewModel)) as ViewModelBase,
                "train" => _services.GetService(typeof(TrainViewModel)) as ViewModelBase,
                "block" => _services.GetService(typeof(BlockViewModel)) as ViewModelBase,
                "blocklist" => _services.GetService(typeof(BlocklistViewModel)) as ViewModelBase,
                "settings" => _services.GetService(typeof(SettingsViewModel)) as ViewModelBase,
                _ => new ViewModelBase()
            } ?? new ViewModelBase();
            _viewCache[viewName] = vm;
        }

        CurrentView = vm;
    }

    [RelayCommand]
    private void SwitchRole(string role)
    {
        CurrentRole = role;
        UpdateNavVisibility();

        if (role == "user" && CurrentView != null)
        {
            var currentName = _viewCache.FirstOrDefault(kvp => kvp.Value == CurrentView).Key;
            if (currentName != null && AdminViews.Contains(currentName))
                Navigate("block");
        }
    }

    private void UpdateNavVisibility()
    {
        foreach (var nav in NavItems)
        {
            if (AdminViews.Contains(nav.ViewName))
                nav.IsVisible = CurrentRole == "admin";
            else
                nav.IsVisible = true;
        }
    }

    // Called by services when connection status changes
    public void OnCdpDisconnected()
    {
        IsConnected = false;
    }

    public void OnCdpConnected()
    {
        IsConnected = true;
    }

    public void OnModelStatusChanged(bool loaded, string? f1)
    {
        IsModelLoaded = loaded;
        ModelInfoText = loaded
            ? (f1 != null ? T("block.model_loaded", new() { ["f1"] = f1 }) : T("block.model_loaded", new() { ["f1"] = "?" }))
            : T("block.model_not_loaded");
    }

    public async void OnLanguageChanged(string lang)
    {
        var i18n = _services.GetService(typeof(II18nService)) as II18nService;
        if (i18n != null)
            await i18n.LoadLanguageAsync(lang);
        BuildNavItems();
        BuildLanguageItems();
        RefreshSidebarLabels();
        // Force current view refresh
        if (CurrentView != null)
            OnPropertyChanged(nameof(CurrentView));
    }
}

public partial class NavItem : ViewModelBase
{
    public string Icon { get; set; }
    public string Label { get; set; }
    public string ViewName { get; set; }

    [ObservableProperty] private bool _isActive;
    [ObservableProperty] private bool _isVisible = true;
    [ObservableProperty] private bool _isDivider;

    public NavItem(string icon, string label, string viewName, bool isVisible = true)
    {
        Icon = icon;
        Label = label;
        ViewName = viewName;
        _isVisible = isVisible;
    }
}

public partial class LanguageItem : ViewModelBase
{
    public string Tag { get; set; }
    [ObservableProperty] private string _label;

    public LanguageItem(string tag, string labelText)
    {
        Tag = tag;
        _label = labelText;
    }
}
