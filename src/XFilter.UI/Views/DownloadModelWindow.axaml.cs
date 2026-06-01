using Avalonia.Controls;
using XFilter.UI.ViewModels;

namespace XFilter.UI.Views;

public partial class DownloadModelWindow : Window
{
    public DownloadModelWindow()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(object? sender, EventArgs e)
    {
        if (DataContext is DownloadModelViewModel vm)
        {
            vm.CloseRequested += success => Close(success);
        }
    }
}
