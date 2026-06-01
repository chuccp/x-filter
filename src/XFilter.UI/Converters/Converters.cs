using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;
using XFilter.UI.ViewModels;

namespace XFilter.UI.Converters;

public static class AppConverters
{
    // Role
    public static readonly IValueConverter IsAdmin =
        new FuncValueConverter<string, bool>(role => role == "admin");
    public static readonly IValueConverter RoleBg = new RoleColorConverter(
        new SolidColorBrush(Color.Parse("#3b82f6")), new SolidColorBrush(Color.Parse("#f1f5f9")));
    public static readonly IValueConverter RoleFg = new RoleColorConverter(
        new SolidColorBrush(Colors.White), new SolidColorBrush(Color.Parse("#475569")));
    // Legacy aliases
    public static readonly IValueConverter RoleBgLight = RoleBg;
    public static readonly IValueConverter RoleFgLight = RoleFg;

    // Connection
    public static readonly IValueConverter ConnectedColor =
        new FuncValueConverter<bool, IBrush>(c => c ? Brushes.LimeGreen : Brushes.Gray);
    public static readonly IValueConverter ConnectedTextColor =
        new FuncValueConverter<bool, IBrush>(c =>
            c ? Brushes.LimeGreen : new SolidColorBrush(Color.Parse("#94a3b8")));

    // Labels
    public static readonly IValueConverter LabelColor =
        new FuncValueConverter<int?, IBrush>(l =>
            l == 1 ? new SolidColorBrush(Color.Parse("#ef4444"))
                    : l == 0 ? new SolidColorBrush(Color.Parse("#10b981"))
                             : Brushes.Gray);
    public static readonly IValueConverter LabelText =
        new FuncValueConverter<int?, string>(l =>
        {
            var i18n = ViewModelBase.I18n;
            return l == 1 ? (i18n?.T("export.tag_spam") ?? "Spam")
                 : l == 0 ? (i18n?.T("export.tag_normal") ?? "Normal")
                 : "?";
        });

    // Blocked
    public static readonly IValueConverter BlockedBadge =
        new FuncValueConverter<int, IBrush>(b =>
            b != 0 ? new SolidColorBrush(Color.Parse("#10b981"))
                   : new SolidColorBrush(Color.Parse("#94a3b8")));
    public static readonly IValueConverter BlockedText =
        new FuncValueConverter<int, string>(b =>
        {
            var i18n = ViewModelBase.I18n;
            return b != 0 ? (i18n?.T("blocklist.status_blocked") ?? "Blocked")
                          : (i18n?.T("blocklist.status_pending") ?? "Pending");
        });

    // Bool inverse
    public static readonly IValueConverter Not =
        new FuncValueConverter<bool, bool>(b => !b);
}

public class RoleColorConverter : IValueConverter
{
    private readonly IBrush _a, _i;
    public RoleColorConverter(IBrush a, IBrush i) { _a = a; _i = i; }
    public object? Convert(object? v, Type t, object? p, CultureInfo c)
        => (v as string) == (p as string) ? _a : _i;
    public object? ConvertBack(object? v, Type t, object? p, CultureInfo c)
        => throw new NotSupportedException();
}
