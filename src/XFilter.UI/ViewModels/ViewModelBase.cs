using CommunityToolkit.Mvvm.ComponentModel;
using XFilter.Core.I18n;

namespace XFilter.UI.ViewModels;

public partial class ViewModelBase : ObservableObject
{
    /// <summary>
    /// Set by App startup. Provides i18n access without circular dependency on XFilter.App.
    /// </summary>
    public static II18nService? I18n { get; set; }

    protected static string T(string key, Dictionary<string, string>? param = null)
    {
        return I18n?.T(key, param) ?? key;
    }

    /// <summary>
    /// Called each time the view is navigated to (even if cached).
    /// Override to refresh data.
    /// </summary>
    public virtual void OnActivated() { }
}
