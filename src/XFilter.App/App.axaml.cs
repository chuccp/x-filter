using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Microsoft.Extensions.DependencyInjection;
using XFilter.Core.Cdp;
using XFilter.Core.Data;
using XFilter.Core.I18n;
using XFilter.Core.Services;
using XFilter.UI.ViewModels;
using XFilter.UI.Views;

namespace XFilter.App;

public partial class App : Application
{
    public static IServiceProvider Services { get; private set; } = null!;

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override async void OnFrameworkInitializationCompleted()
    {
        var services = new ServiceCollection();

        // Core services (singletons)
        services.AddSingleton<IDatabaseService, DatabaseService>();
        services.AddSingleton<ICdpClient, CdpClient>();
        services.AddSingleton<II18nService, I18nService>();
        services.AddSingleton<IModelService, ModelService>();

        // Core services (transient)
        services.AddTransient<IScraperService, ScraperService>();
        services.AddTransient<IBlockerService, BlockerService>();
        services.AddTransient<IHfDownloader, HfDownloader>();
        services.AddTransient<ITrainingService, TrainingService>();

        // ViewModels
        services.AddTransient<DownloadModelViewModel>();
        services.AddTransient<MainViewModel>();
        services.AddTransient<ConnectViewModel>();
        services.AddTransient<CollectViewModel>();
        services.AddTransient<LabelViewModel>();
        services.AddTransient<DataViewModel>();
        services.AddTransient<TrainViewModel>();
        services.AddTransient<BlockViewModel>();
        services.AddTransient<BlocklistViewModel>();
        services.AddTransient<SettingsViewModel>();

        Services = services.BuildServiceProvider();

        // Wire up static i18n access for ViewModelBase.T() and converters
        ViewModelBase.I18n = Services.GetRequiredService<II18nService>();

        // Initialize i18n resources for DynamicResource bindings (loads default lang first)
        await I18nResources.InitAsync(Services);

        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var mainVm = Services.GetRequiredService<MainViewModel>();
            desktop.MainWindow = new MainWindow { DataContext = mainVm };
        }

        base.OnFrameworkInitializationCompleted();
    }
}

/// <summary>
/// Manages Avalonia ResourceDictionary for i18n translations,
/// enabling {DynamicResource key} bindings in XAML with live language switching.
/// </summary>
public static class I18nResources
{
    private static ResourceDictionary? _dict;
    private static II18nService? _i18n;

    public static async Task InitAsync(IServiceProvider services)
    {
        _i18n = services.GetRequiredService<II18nService>();

        // Load default language before building the resource dictionary
        await _i18n.LoadLanguageAsync(_i18n.CurrentLanguage);

        _dict = BuildDict(_i18n.GetTranslations());
        Application.Current!.Resources.MergedDictionaries.Add(_dict);

        _i18n.LanguageChanged += (_, _) =>
        {
            if (Application.Current is { } app)
            {
                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    var merged = app.Resources.MergedDictionaries;
                    if (_dict != null) merged.Remove(_dict);
                    _dict = BuildDict(_i18n.GetTranslations());
                    merged.Add(_dict);
                });
            }
        };
    }

    private static ResourceDictionary BuildDict(IReadOnlyDictionary<string, string> translations)
    {
        var dict = new ResourceDictionary();
        foreach (var (key, value) in translations)
            dict[key] = value;
        return dict;
    }
}
