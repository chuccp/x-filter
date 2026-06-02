using Avalonia.Input;
using Avalonia.Controls;
using XFilter.UI.ViewModels;

namespace XFilter.UI.Views;

public partial class LabelView : UserControl
{
    public LabelView()
    {
        InitializeComponent();
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (DataContext is LabelViewModel vm)
        {
            var key = e.Key.ToString();
            // Normalize arrow keys
            if (e.Key == Key.Right) key = "Right";
            else if (e.Key == Key.Left) key = "Left";
            vm.OnKeyDown(key);
            e.Handled = true;
        }
    }
}
