using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using XFilter.Core.Cdp;

namespace XFilter.UI.ViewModels;

public partial class ConnectViewModel : ViewModelBase
{
    private readonly ICdpClient _cdp;
    [ObservableProperty] private string _host = "127.0.0.1";
    [ObservableProperty] private int _port = 9222;
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private bool _isConnected;
    [ObservableProperty] private bool _isConnecting;

    public ConnectViewModel(ICdpClient cdp)
    {
        _cdp = cdp;
        _cdp.Disconnected += (_, _) =>
        {
            IsConnected = false;
            Status = T("connect.disconnected");
            if (Avalonia.Threading.Dispatcher.UIThread.CheckAccess())
                OnPropertyChanged(nameof(IsConnected));
            else
                Avalonia.Threading.Dispatcher.UIThread.Post(() => OnPropertyChanged(nameof(IsConnected)));
        };
    }

    [RelayCommand]
    private async Task ConnectAsync()
    {
        if (IsConnecting) return;
        IsConnecting = true;
        Status = T("connect.connecting");
        try
        {
            await _cdp.ConnectAsync(Host, Port);
            IsConnected = true;
            Status = T("connect.connected");
        }
        catch (Exception ex)
        {
            IsConnected = false;
            Status = T("connect.connect_fail", new() { ["error"] = ex.Message });
        }
        finally
        {
            IsConnecting = false;
            OnPropertyChanged(nameof(IsConnected));
        }
    }

    [RelayCommand]
    private void Disconnect()
    {
        _cdp.Disconnect();
        IsConnected = false;
        Status = T("connect.disconnected");
    }
}
