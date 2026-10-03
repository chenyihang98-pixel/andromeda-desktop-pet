// First-party, read-only Windows foreground fullscreen probe.
// Build with scripts/build-windows-helper.cjs. No window titles, contents,
// executable paths, network access, hooks, or administrative rights are used.
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

internal static class WindowsFullscreen
{
    private const uint WsVisible = 0x10000000;
    private const uint WsCaption = 0x00C00000;
    private const uint WsThickFrame = 0x00040000;
    private const uint WsChild = 0x40000000;
    private const uint WsExToolWindow = 0x00000080;
    private const uint WsExNoActivate = 0x08000000;
    private static readonly ManualResetEvent Shutdown = new ManualResetEvent(false);
    private static int ownPid;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        public int Left, Top, Right, Bottom;
        public Rect(int left, int top, int right, int bottom)
        { Left = left; Top = top; Right = right; Bottom = bottom; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, Work;
        public uint Flags;
    }

    // Also used by --self-test: fixture policy does not call any Windows APIs.
    internal sealed class Snapshot
    {
        public bool Valid, Visible, Minimized, Cloaked, Maximized, Shell, Owned;
        public uint ProcessId, Style, ExtendedStyle;
        public Rect Window, Frame, Client, Monitor;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetClientRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetFrame(IntPtr window, uint attribute, out Rect rectangle, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    private static extern int GetCloaked(IntPtr window, uint attribute, out uint value, int size);

    private static bool ValidRect(Rect rectangle)
    {
        long width = (long)rectangle.Right - rectangle.Left;
        long height = (long)rectangle.Bottom - rectangle.Top;
        return Math.Abs((long)rectangle.Left) <= 10000000 && Math.Abs((long)rectangle.Top) <= 10000000
            && Math.Abs((long)rectangle.Right) <= 10000000 && Math.Abs((long)rectangle.Bottom) <= 10000000
            && width > 0 && height > 0 && width <= 100000 && height <= 100000;
    }

    private static bool Matches(Rect rectangle, Rect monitor)
    {
        // Small compositor rounding tolerance, in physical pixels, never DIP.
        return ValidRect(rectangle) && Math.Abs((long)rectangle.Left - monitor.Left) <= 2
            && Math.Abs((long)rectangle.Top - monitor.Top) <= 2
            && Math.Abs((long)rectangle.Right - monitor.Right) <= 2
            && Math.Abs((long)rectangle.Bottom - monitor.Bottom) <= 2;
    }

    internal static bool IsFullscreen(Snapshot sample, uint parentPid)
    {
        if (sample == null || !sample.Valid || !sample.Visible || sample.ProcessId == 0
            || sample.ProcessId == parentPid || sample.Minimized || sample.Cloaked
            || sample.Shell || sample.Owned) return false;
        // Windows can retain WS_MAXIMIZE / IsZoomed when a maximized application
        // enters real fullscreen. Exclude ordinary maximized windows using their
        // chrome and full client/frame/window geometry, not that flag alone.
        if ((sample.Style & WsVisible) == 0 || (sample.Style & (WsCaption | WsThickFrame | WsChild)) != 0
            || (sample.ExtendedStyle & (WsExToolWindow | WsExNoActivate)) != 0) return false;
        return ValidRect(sample.Monitor) && Matches(sample.Window, sample.Monitor)
            && Matches(sample.Frame, sample.Monitor) && Matches(sample.Client, sample.Monitor);
    }

    private static bool IsShellClass(string value)
    {
        foreach (string name in new string[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
            "MultitaskingViewFrame", "TaskSwitcherWnd", "XamlExplorerHostIslandWindow" })
            if (String.Equals(name, value, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static Snapshot ReadForeground(uint parentPid)
    {
        Snapshot sample = new Snapshot();
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero || GetAncestor(window, 2) != window) return sample;
        if (GetWindowThreadProcessId(window, out sample.ProcessId) == 0 || sample.ProcessId == parentPid
            || sample.ProcessId == (uint)ownPid) return sample;
        sample.Visible = IsWindowVisible(window);
        sample.Minimized = IsIconic(window);
        sample.Maximized = IsZoomed(window);
        sample.Owned = GetWindow(window, 4) != IntPtr.Zero;
        IntPtr shell = GetShellWindow();
        uint shellPid;
        sample.Shell = window == GetDesktopWindow() || window == shell
            || (shell != IntPtr.Zero && GetWindowThreadProcessId(shell, out shellPid) != 0 && shellPid == sample.ProcessId);
        StringBuilder className = new StringBuilder(256);
        if (GetClassName(window, className, className.Capacity) == 0) return sample;
        sample.Shell = sample.Shell || IsShellClass(className.ToString());
        sample.Style = unchecked((uint)GetWindowLongPtr(window, -16).ToInt64());
        sample.ExtendedStyle = unchecked((uint)GetWindowLongPtr(window, -20).ToInt64());
        uint cloaked;
        if (GetCloaked(window, 14, out cloaked, sizeof(uint)) != 0) return sample;
        sample.Cloaked = cloaked != 0;
        if (!GetWindowRect(window, out sample.Window)
            || GetFrame(window, 9, out sample.Frame, Marshal.SizeOf(typeof(Rect))) != 0) return sample;
        Rect client;
        if (!GetClientRect(window, out client)) return sample;
        Point start = new Point { X = client.Left, Y = client.Top };
        Point end = new Point { X = client.Right, Y = client.Bottom };
        if (!ClientToScreen(window, ref start) || !ClientToScreen(window, ref end)) return sample;
        sample.Client = new Rect(start.X, start.Y, end.X, end.Y);
        MonitorInfo info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        IntPtr monitor = MonitorFromWindow(window, 2);
        if (monitor == IntPtr.Zero || !GetMonitorInfo(monitor, ref info)) return sample;
        sample.Monitor = info.Monitor;
        // Reject an inconsistent snapshot when activation changed during calls.
        sample.Valid = GetForegroundWindow() == window;
        return sample;
    }

    internal static string Serialize(Snapshot sample, uint parentPid)
    {
        if (!IsFullscreen(sample, parentPid)) return "{\"version\":1,\"fullscreen\":false}";
        Rect monitor = sample.Monitor;
        return String.Format(CultureInfo.InvariantCulture,
            "{{\"version\":1,\"fullscreen\":true,\"monitor\":{{\"x\":{0},\"y\":{1},\"width\":{2},\"height\":{3}}}}}",
            monitor.Left, monitor.Top, (long)monitor.Right - monitor.Left, (long)monitor.Bottom - monitor.Top);
    }

    private static Snapshot Fixture()
    {
        Rect monitor = new Rect(-2560, -200, 0, 1240);
        return new Snapshot { Valid = true, Visible = true, ProcessId = 42, Style = WsVisible,
            Window = monitor, Frame = monitor, Client = monitor, Monitor = monitor };
    }

    private static int SelfTest()
    {
        int passed = 0;
        Action<bool> check = delegate(bool result) { if (!result) throw new InvalidOperationException(); passed++; };
        try
        {
            check(IsFullscreen(Fixture(), 7));
            check(!IsFullscreen(Fixture(), 42));
            check(!IsFullscreen(null, 7));
            Action<Action<Snapshot>> reject = delegate(Action<Snapshot> change) {
                Snapshot sample = Fixture(); change(sample); check(!IsFullscreen(sample, 7));
            };
            reject(delegate(Snapshot sample) { sample.Valid = false; });
            reject(delegate(Snapshot sample) { sample.Visible = false; });
            reject(delegate(Snapshot sample) { sample.ProcessId = 0; });
            reject(delegate(Snapshot sample) { sample.Minimized = true; });
            reject(delegate(Snapshot sample) { sample.Cloaked = true; });
            Snapshot retainedMaximize = Fixture();
            retainedMaximize.Maximized = true; retainedMaximize.Style |= 0x01000000;
            check(IsFullscreen(retainedMaximize, 7));
            Snapshot decoratedMaximize = Fixture();
            decoratedMaximize.Maximized = true; decoratedMaximize.Style |= WsCaption | WsThickFrame;
            check(!IsFullscreen(decoratedMaximize, 7));
            decoratedMaximize.Maximized = false; check(!IsFullscreen(decoratedMaximize, 7));
            Snapshot workAreaMaximize = Fixture();
            workAreaMaximize.Maximized = true;
            workAreaMaximize.Window.Bottom -= 96;
            workAreaMaximize.Frame.Bottom -= 96;
            workAreaMaximize.Client.Bottom -= 96;
            check(!IsFullscreen(workAreaMaximize, 7));
            workAreaMaximize.Maximized = false; check(!IsFullscreen(workAreaMaximize, 7));
            reject(delegate(Snapshot sample) { sample.Shell = true; });
            reject(delegate(Snapshot sample) { sample.Owned = true; });
            reject(delegate(Snapshot sample) { sample.Style = 0; });
            foreach (uint style in new uint[] { WsCaption, WsThickFrame, WsChild })
                reject(delegate(Snapshot sample) { sample.Style |= style; });
            foreach (uint style in new uint[] { WsExToolWindow, WsExNoActivate })
                reject(delegate(Snapshot sample) { sample.ExtendedStyle = style; });
            reject(delegate(Snapshot sample) { sample.Client.Top += 30; });
            reject(delegate(Snapshot sample) { sample.Frame.Bottom -= 40; });
            reject(delegate(Snapshot sample) { sample.Window.Left -= 8; });
            reject(delegate(Snapshot sample) { sample.Monitor.Right = sample.Monitor.Left; });
            reject(delegate(Snapshot sample) { sample.Monitor.Right = Int32.MaxValue; });
            Snapshot rounded = Fixture(); rounded.Frame.Left += 2; check(IsFullscreen(rounded, 7));
            rounded.Frame.Left++; check(!IsFullscreen(rounded, 7));
            foreach (string name in new string[] { "Progman", "workerw", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
                "MultitaskingViewFrame", "TaskSwitcherWnd", "XamlExplorerHostIslandWindow" }) check(IsShellClass(name));
            check(!IsShellClass("ApplicationWindow"));
            check(Serialize(Fixture(), 7) == "{\"version\":1,\"fullscreen\":true,\"monitor\":{\"x\":-2560,\"y\":-200,\"width\":2560,\"height\":1440}}");
            check(Serialize(Fixture(), 42) == "{\"version\":1,\"fullscreen\":false}");
            Console.WriteLine("{\"version\":1,\"selfTest\":true,\"passed\":" + passed.ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }
        catch
        {
            Console.Error.WriteLine("Fullscreen helper policy fixture failed at assertion " + (passed + 1).ToString(CultureInfo.InvariantCulture));
            return 1;
        }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
        using (Process self = Process.GetCurrentProcess()) ownPid = self.Id;
        int parentPid;
        if (args.Length != 2 || args[0] != "--parent-pid"
            || !Int32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out parentPid)
            || parentPid <= 0 || parentPid == ownPid) return 2;
        try
        {
            using (Process parent = Process.GetProcessById(parentPid))
            {
                // Pin the parent process object before polling to avoid following a reused PID.
                IntPtr parentHandle = parent.Handle;
                Thread input = new Thread(delegate() {
                    try { while (Console.Read() != -1) { } } catch { }
                    finally { Shutdown.Set(); }
                });
                input.IsBackground = true;
                input.Start();
                while (!Shutdown.WaitOne(0) && !parent.HasExited)
                {
                    string result;
                    try { result = Serialize(ReadForeground((uint)parentPid), (uint)parentPid); }
                    catch { result = "{\"version\":1,\"fullscreen\":false}"; }
                    try { Console.WriteLine(result); Console.Out.Flush(); }
                    catch { break; }
                    if (Shutdown.WaitOne(500)) break;
                }
            }
        }
        catch { /* Missing parent, closed pipes, or unavailable OS: exit quietly. */ }
        return 0;
    }
}
