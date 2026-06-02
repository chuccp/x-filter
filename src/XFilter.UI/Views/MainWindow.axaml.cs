using Avalonia.Controls;
using Avalonia.Input;
using XFilter.UI.ViewModels;

namespace XFilter.UI.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void RoleToggle_Click(object? sender, PointerPressedEventArgs e)
    {
        if (sender is Border border && border.Tag is string role)
        {
            if (DataContext is MainViewModel vm)
                vm.SwitchRoleCommand.Execute(role);
        }
    }

    private void LangCombo_SelectionChanged(object? sender, SelectionChangedEventArgs e)
    {
        if (sender is ComboBox cb && cb.SelectedItem is LanguageItem item)
        {
            if (DataContext is MainViewModel vm)
                vm.OnLanguageChanged(item.Tag);
        }
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (DataContext is MainViewModel vm && vm.CurrentView is LabelViewModel labelVm)
        {
            var key = e.Key switch
            {
                Key.Right => "Right",
                Key.Left => "Left",
                _ => e.Key.ToString()
            };
            labelVm.OnKeyDown(key);
            e.Handled = true;
        }
    }
}
