#Requires -Version 5.1
<#
.SYNOPSIS
  Windows computer-use action layer. One JSON object per run on stdout.

.DESCRIPTION
  Everything the agent needs to see and drive the desktop:
    info          monitors, virtual screen origin, cursor position, DPI
    windows       visible top-level windows in z-order
    screenshot    full virtual desktop / region / foreground window -> PNG or JPEG
    move          SetCursorPos
    click         button + click count, optionally at a point
    drag          press at A, interpolate, release at B
    scroll        wheel ticks at the cursor (or at a point)
    type          unicode text via KEYEVENTF_UNICODE (CJK safe)
    key           one named key or combo, e.g. "ctrl+shift+t"
    hotkey        same as key, kept for readability at the call site
    wait          sleep, for UI settle time

  Coordinate space is the Windows *virtual desktop* space: origin is the
  top-left of the leftmost/topmost monitor, so X/Y may be negative.
  Screen bounds are always reported so the caller can map coordinates.

.NOTES
  Self-contained: no modules, no network, no admin rights required.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Action,

  # Point A (move / click / scroll / drag start)
  [int]$X = [int]::MinValue,
  [int]$Y = [int]::MinValue,
  # Point B (drag end)
  [int]$X2 = [int]::MinValue,
  [int]$Y2 = [int]::MinValue,

  [ValidateSet('left', 'right', 'middle')][string]$Button = 'left',
  [ValidateRange(1, 5)][int]$ClickCount = 1,
  [int]$Amount = 3,          # scroll wheel ticks
  [ValidateSet('vertical', 'horizontal')][string]$Axis = 'vertical',
  [int]$DurationMs = 400,    # drag duration
  [int]$DelayMs = 12,        # inter-key / inter-char delay
  [int]$SettleMs = 60,       # delay between mouse button down and up

  [string]$Text,
  [string]$Key,

  # focus
  [string]$Title,        # case-insensitive substring; empty = the foreground window
  [int]$Index = 0,       # focus: pick the Nth window matching -Title

  # Safety guards, honoured by every state-changing action.
  # NOTE: do not name these -Expect/-Focus. PowerShell 5.1 swallows a parameter
  # literally called "Expect" when the script runs via -File, exiting -1 with no
  # output at all. -MustBeFront / -Focus are safe.
  [string]$MustBeFront,  # abort unless the foreground title contains this
  [string]$Focus,        # activate the window whose title contains this, then verify
  [switch]$Quiet,        # suppress the JSON body; exit code only

  # screenshot
  [string]$Out,
  [ValidateSet('png', 'jpeg')][string]$Format = 'png',
  [int]$MaxWidth = 0,        # downscale to this width, 0 = keep
  [ValidateRange(1, 100)][int]$Quality = 82,
  [switch]$Foreground,       # screenshot only the active window
  [int]$Windows = 30         # windows: how many to report
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# --------------------------------------------------------------------------
# Native interop
# --------------------------------------------------------------------------
if (-not ('CU.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace CU {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx; public int dy; public uint mouseData;
    public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags;
    public uint time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL; public ushort wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X, Y; }

  public class WinInfo {
    public IntPtr Handle; public string Title; public string ClassName;
    public int Pid; public int Left, Top, Width, Height; public bool Foreground;
  }

  public static class Native {
    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP   = 0x0040;
    public const uint MOUSEEVENTF_WHEEL      = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL     = 0x1000;

    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP       = 0x0002;
    public const uint KEYEVENTF_UNICODE     = 0x0004;

    public const uint SRCCOPY = 0x00CC0020;

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, [In] INPUT[] inputs, int size);

    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr h, StringBuilder s, int max);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
    public delegate bool EnumProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);

    /// <summary>Bring a window to the foreground, bypassing the foreground lock.</summary>
    public static bool Focus(IntPtr target) {
      if (target == IntPtr.Zero) return false;
      if (IsIconic(target)) ShowWindow(target, 9); // SW_RESTORE
      uint ignoredPid;
      uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out ignoredPid);
      uint myThread = GetCurrentThreadId();
      bool attached = false;
      if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
      try {
        BringWindowToTop(target);
        ShowWindow(target, 5); // SW_SHOW
        return SetForegroundWindow(target);
      } finally {
        if (attached) AttachThreadInput(myThread, fgThread, false);
      }
    }

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    public static int InputSize { get { return Marshal.SizeOf(typeof(INPUT)); } }

    static INPUT Mouse(uint flags, int data) {
      INPUT i = new INPUT();
      i.type = INPUT_MOUSE;
      i.u.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = (uint)data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
      return i;
    }

    public static void SendMouse(uint flags, int data) {
      INPUT[] a = new INPUT[] { Mouse(flags, data) };
      SendInput(1, a, InputSize);
    }

    public static void SendKeyVk(ushort vk, bool up) {
      INPUT[] a = new INPUT[2];
      a[0].type = INPUT_KEYBOARD;
      a[0].u.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = up ? KEYEVENTF_KEYUP : 0, time = 0, dwExtraInfo = IntPtr.Zero };
      a[1] = a[0];
      a[1].u.ki.dwFlags = a[0].u.ki.dwFlags | KEYEVENTF_KEYUP;
      SendInput(2, a, InputSize);
    }

    public static void SendUnicode(char c) {
      INPUT[] a = new INPUT[2];
      for (int i = 0; i < 2; i++) {
        a[i].type = INPUT_KEYBOARD;
        a[i].u.ki = new KEYBDINPUT {
          wVk = 0, wScan = (ushort)c,
          dwFlags = KEYEVENTF_UNICODE | (i == 1 ? KEYEVENTF_KEYUP : 0),
          time = 0, dwExtraInfo = IntPtr.Zero
        };
      }
      SendInput(2, a, InputSize);
    }

    public static List<WinInfo> ListWindows() {
      List<WinInfo> list = new List<WinInfo>();
      IntPtr fg = GetForegroundWindow();
      EnumWindows(delegate(IntPtr h, IntPtr p) {
        if (!IsWindowVisible(h)) return true;
        StringBuilder t = new StringBuilder(512);
        GetWindowTextW(h, t, 512);
        if (t.Length == 0) return true;
        StringBuilder c = new StringBuilder(256);
        GetClassNameW(h, c, 256);
        uint pid; GetWindowThreadProcessId(h, out pid);
        RECT r; GetWindowRect(h, out r);
        WinInfo w = new WinInfo();
        w.Handle = h; w.Title = t.ToString(); w.ClassName = c.ToString();
        w.Pid = (int)pid; w.Left = r.Left; w.Top = r.Top;
        w.Width = r.Right - r.Left; w.Height = r.Bottom - r.Top;
        w.Foreground = (h == fg);
        list.Add(w);
        return true;
      }, IntPtr.Zero);
      return list;
    }
  }
}
'@
}

# Per-monitor DPI awareness so pixels in a screenshot == coordinates we send.
try {
  [CU.Native]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null   # PER_MONITOR_AWARE_V2
} catch {
  try { [CU.Native]::SetProcessDPIAware() | Out-Null } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
$script:ExtendedKeys = @(
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'insert', 'delete', 'printscreen', 'numlock', 'lwin', 'rwin', 'apps'
)

$script:VkMap = @{
  'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D
  'shift' = 0x10; 'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'menu' = 0x12
  'pause' = 0x13; 'capslock' = 0x14; 'esc' = 0x1B; 'escape' = 0x1B
  'space' = 0x20; 'pageup' = 0x21; 'pagedown' = 0x22; 'end' = 0x23; 'home' = 0x24
  'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
  'insert' = 0x2D; 'delete' = 0x2E; 'printscreen' = 0x2C; 'numlock' = 0x90
  'lwin' = 0x5B; 'rwin' = 0x5C; 'apps' = 0x5D; 'scrolllock' = 0x91
  'multiply' = 0x6A; 'add' = 0x6B; 'subtract' = 0x6D; 'divide' = 0x6F; 'decimal' = 0x6E
  'separator' = 0x6C; 'num0' = 0x60; 'num1' = 0x61; 'num2' = 0x62; 'num3' = 0x63
  'num4' = 0x64; 'num5' = 0x65; 'num6' = 0x66; 'num7' = 0x67; 'num8' = 0x68; 'num9' = 0x69
  ';' = 0xBA; '=' = 0xBB; ',' = 0xBC; '-' = 0xBD; '.' = 0xBE; '/' = 0xBF
  '`' = 0xC0; '[' = 0xDB; '\' = 0xDC; ']' = 0xDD; "'" = 0xDE
}

for ($i = 0; $i -le 9; $i++) { $script:VkMap[[string]$i] = 0x30 + $i }
for ($i = 0; $i -lt 26; $i++) { $script:VkMap[[string][char](65 + $i)] = 0x41 + $i }
for ($i = 1; $i -le 24; $i++) { $script:VkMap["f$i"] = 0x70 + $i - 1 }

function Resolve-KeyName([string]$name) {
  $n = $name.Trim().ToLowerInvariant()
  switch ($n) {
    'command' { $n = 'lwin' }
    'cmd' { $n = 'lwin' }
    'super' { $n = 'lwin' }
    'meta' { $n = 'lwin' }
    'win' { $n = 'lwin' }
    'option' { $n = 'alt' }
    'control' { $n = 'ctrl' }
    'esc' { $n = 'escape' }
    'return' { $n = 'enter' }
    'del' { $n = 'delete' }
    'ins' { $n = 'insert' }
    'pgup' { $n = 'pageup' }
    'pgdn' { $n = 'pagedown' }
    'page_up' { $n = 'pageup' }
    'page_down' { $n = 'pagedown' }
  }
  if ($script:VkMap.ContainsKey($n)) { return [int]$script:VkMap[$n] }
  throw "Unknown key name: '$name'"
}

function Send-KeyName([string]$name) {
  $vk = [uint16](Resolve-KeyName $name)
  $ext = if ($script:ExtendedKeys -contains $name.Trim().ToLowerInvariant()) { 1 } else { 0 }
  $flagsDown = $ext * [int][CU.Native]::KEYEVENTF_EXTENDEDKEY
  $flagsUp = $flagsDown -bor [int][CU.Native]::KEYEVENTF_KEYUP
  $inputs = New-Object 'CU.INPUT[]' 2
  $inputs[0].type = [CU.Native]::INPUT_KEYBOARD
  $inputs[0].u.ki = New-Object CU.KEYBDINPUT
  $inputs[0].u.ki.wVk = $vk; $inputs[0].u.ki.wScan = 0
  $inputs[0].u.ki.dwFlags = [uint32]$flagsDown
  $inputs[0].u.ki.time = 0; $inputs[0].u.ki.dwExtraInfo = [IntPtr]::Zero
  $inputs[1] = $inputs[0]
  $inputs[1].u.ki.dwFlags = [uint32]$flagsUp
  [CU.Native]::SendInput(2, $inputs, [CU.Native]::InputSize) | Out-Null
}

function Get-CursorPoint {
  $p = New-Object CU.POINT
  [CU.Native]::GetCursorPos([ref]$p) | Out-Null
  return @{ x = $p.X; y = $p.Y }
}

function Get-VirtualScreen { [System.Windows.Forms.SystemInformation]::VirtualScreen }

function Set-ForegroundByTitle([string]$needle, [int]$idx) {
  $matches = @([CU.Native]::ListWindows() | Where-Object { $_.Title -like "*$needle*" })
  if ($matches.Count -eq 0) { throw "No visible window whose title contains '$needle'" }
  if ($idx -lt 0 -or $idx -ge $matches.Count) { throw "Index $idx out of range; $($matches.Count) window(s) match '$needle'" }
  $target = $matches[$idx]
  $ok = [CU.Native]::Focus($target.Handle)
  Start-Sleep -Milliseconds 250
  $after = Get-ForegroundWindowInfo
  if ($null -eq $after -or $after['title'] -ne $target.Title) {
    throw "Focus failed: wanted '$($target.Title)' but foreground is '$($after['title'])'"
  }
  return @{ requested = $target.Title; setForegroundWindow = $ok; matches = $matches.Count; verified = $true }
}

# Runs before every action that changes machine state. Resolving the target
# window first is what stops keystrokes from leaking into whatever app happens
# to be in front, so this is not optional decoration.
function Invoke-TargetGuard([hashtable]$res) {
  if (-not [string]::IsNullOrWhiteSpace($Focus)) {
    $res.focus = Set-ForegroundByTitle $Focus $Index
  }
  $fg = Get-ForegroundWindowInfo
  $res.foregroundWindow = $fg
  if (-not [string]::IsNullOrWhiteSpace($MustBeFront)) {
    if ($null -eq $fg -or $fg['title'] -notlike "*$MustBeFront*") {
      throw "ABORT: foreground is '$($fg['title'])', expected '*$MustBeFront*'. Pass -Focus '<title>' to switch windows first."
    }
  }
}

function Get-ForegroundWindowInfo {
  $h = [CU.Native]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return $null }
  $t = New-Object System.Text.StringBuilder 512
  [CU.Native]::GetWindowTextW($h, $t, 512) | Out-Null
  $c = New-Object System.Text.StringBuilder 256
  [CU.Native]::GetClassNameW($h, $c, 256) | Out-Null
  $pid2 = 0
  [CU.Native]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  $r = New-Object CU.RECT
  [CU.Native]::GetWindowRect($h, [ref]$r) | Out-Null
  return @{
    title = $t.ToString(); class = $c.ToString(); pid = [int]$pid2
    x = $r.Left; y = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top)
  }
}

function Get-MonitorList {
  $out = @()
  foreach ($m in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $m.Bounds
    $out += @{
      deviceName  = $m.DeviceName
      primary     = $m.Primary
      x           = $b.X
      y           = $b.Y
      width       = $b.Width
      height      = $b.Height
      workingArea = "$($m.WorkingArea.X),$($m.WorkingArea.Y),$($m.WorkingArea.Width),$($m.WorkingArea.Height)"
      scaleFactor = [math]::Round($m.Bounds.Width / [double]($m.WorkingArea.Width * 1.0), 2)
    }
  }
  return $out
}

function New-ScreenBitmap([System.Drawing.Rectangle]$rect) {
  $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dst = $g.GetHdc()
  try {
    $src = [CU.Native]::GetDC([IntPtr]::Zero)
    try {
      [CU.Native]::BitBlt($dst, 0, 0, $rect.Width, $rect.Height, $src, $rect.Left, $rect.Top, [int][CU.Native]::SRCCOPY) | Out-Null
    } finally { [CU.Native]::ReleaseDC([IntPtr]::Zero, $src) | Out-Null }
  } finally { $g.ReleaseHdc($dst); $g.Dispose() }
  return $bmp
}

function Save-Bitmap([System.Drawing.Bitmap]$bmp, [string]$path, [string]$fmt, [int]$q) {
  $dir = Split-Path -Parent $path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if ($fmt -eq 'jpeg') {
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
    $bmp.Save($path, $enc, $ep)
  } else {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
}

# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------
$vs = Get-VirtualScreen
$result = @{ ok = $true; action = $Action }
$exitCode = 0

try {

switch ($Action.ToLowerInvariant()) {

  'info' {
    $fg = [CU.Native]::GetForegroundWindow()
    $r = New-Object CU.RECT
    [CU.Native]::GetWindowRect($fg, [ref]$r) | Out-Null
    $result.monitors = Get-MonitorList
    $result.virtualScreen = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
    $result.cursor = Get-CursorPoint
    $result.foreground = @{ left = $r.Left; top = $r.Top; width = ($r.Right - $r.Left); height = ($r.Bottom - $r.Top) }
    $result.foregroundWindow = Get-ForegroundWindowInfo
    $result.coordinateSpace = "virtual desktop; origin ($($vs.X),$($vs.Y)); X/Y may be negative"
  }

  'focus' {
    if ([string]::IsNullOrWhiteSpace($Title)) {
      $result.focused = Get-ForegroundWindowInfo
      $result.note = "no -Title given, reported the current foreground window"
    } else {
      $matches = @([CU.Native]::ListWindows() | Where-Object { $_.Title -like "*$Title*" })
      if ($matches.Count -eq 0) { throw "No visible window whose title contains '$Title'" }
      if ($Index -lt 0 -or $Index -ge $matches.Count) { throw "Index $Index out of range; $($matches.Count) window(s) match '$Title'" }
      $target = $matches[$Index]
      $ok = [CU.Native]::Focus($target.Handle)
      Start-Sleep -Milliseconds 250
      $after = Get-ForegroundWindowInfo
      $result.requested = $target.Title
      $result.setForegroundWindow = $ok
      $result.focused = $after
      $result.matches = $matches.Count
      $result.verified = ($null -ne $after -and $after['title'] -eq $target.Title)
      if (-not $result.verified) { throw "Focus request did not take effect; foreground is '$($after['title'])'" }
    }
  }

  'windows' {
    $list = @()
    foreach ($w in [CU.Native]::ListWindows()) {
      if ($list.Count -ge $Windows) { break }
      $list += @{ title = $w.Title; class = $w.ClassName; pid = $w.Pid; x = $w.Left; y = $w.Top; width = $w.Width; height = $w.Height; foreground = $w.Foreground }
    }
    $result.windows = $list
    $result.count = $list.Count
  }

  'screenshot' {
    if ($Foreground) {
      $fg = [CU.Native]::GetForegroundWindow()
      $r = New-Object CU.RECT
      if (-not [CU.Native]::GetWindowRect($fg, [ref]$r)) { throw "Cannot read foreground window rect" }
      $rect = New-Object System.Drawing.Rectangle($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
      $result.region = @{ kind = 'foreground'; x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height }
    } elseif ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
      if ($X2 -eq [int]::MinValue) { $X2 = $X + 400 }
      if ($Y2 -eq [int]::MinValue) { $Y2 = $Y + 300 }
      $rect = New-Object System.Drawing.Rectangle($X, $Y, ($X2 - $X), ($Y2 - $Y))
      $result.region = @{ kind = 'explicit'; x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height }
    } else {
      $rect = $vs
      $result.region = @{ kind = 'virtual'; x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
    }
    if ($rect.Width -le 0 -or $rect.Height -le 0) { throw "Refusing to capture empty region $($rect.Width)x$($rect.Height)" }

    $bmp = New-ScreenBitmap $rect
    try {
      $scale = 1.0
      if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
        $nw = $MaxWidth
        $nh = [int][math]::Round($bmp.Height * $MaxWidth / [double]$bmp.Width)
        $small = New-Object System.Drawing.Bitmap($nw, $nh)
        $g2 = [System.Drawing.Graphics]::FromImage($small)
        $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g2.DrawImage($bmp, 0, 0, $nw, $nh)
        $g2.Dispose()
        $bmp.Dispose(); $bmp = $small
        $scale = $nw / [double]$rect.Width
      }
      $path = if ($Out) { $Out } else { Join-Path ([System.IO.Path]::GetTempPath()) ("cu-" + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff') + "." + $Format) }
      Save-Bitmap $bmp $path $Format $Quality
      $result.path = (Resolve-Path -LiteralPath $path).Path
      $result.mime = if ($Format -eq 'jpeg') { 'image/jpeg' } else { 'image/png' }
      $result.bytes = (Get-Item -LiteralPath $result.path).Length
      $result.imageWidth = $bmp.Width
      $result.imageHeight = $bmp.Height
      $result.scale = [math]::Round($scale, 4)
      $result.coordinateSpace = "virtual desktop; region origin ($($rect.X),$($rect.Y)); divide image coords by scale to get screen coords"
    } finally { $bmp.Dispose() }
  }

  'move' {
    Invoke-TargetGuard $result
    if ($X -eq [int]::MinValue) { throw "move requires -X and -Y" }
    [CU.Native]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 40
    $result.cursor = Get-CursorPoint
    $result.requested = @{ x = $X; y = $Y }
  }

  'click' {
    Invoke-TargetGuard $result
    if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
      [CU.Native]::SetCursorPos($X, $Y) | Out-Null
      Start-Sleep -Milliseconds 30
    }
    $down = @{ left = [CU.Native]::MOUSEEVENTF_LEFTDOWN; right = [CU.Native]::MOUSEEVENTF_RIGHTDOWN; middle = [CU.Native]::MOUSEEVENTF_MIDDLEDOWN }[$Button]
    $up = @{ left = [CU.Native]::MOUSEEVENTF_LEFTUP; right = [CU.Native]::MOUSEEVENTF_RIGHTUP; middle = [CU.Native]::MOUSEEVENTF_MIDDLEUP }[$Button]
    for ($i = 0; $i -lt $ClickCount; $i++) {
      [CU.Native]::SendMouse($down, 0)
      Start-Sleep -Milliseconds $SettleMs
      [CU.Native]::SendMouse($up, 0)
      if ($i -lt $ClickCount - 1) { Start-Sleep -Milliseconds 40 }
    }
    $result.cursor = Get-CursorPoint
    $result.button = $Button
    $result.clickCount = $ClickCount
  }

  'drag' {
    Invoke-TargetGuard $result
    if ($X -eq [int]::MinValue -or $X2 -eq [int]::MinValue) { throw "drag requires -X -Y -X2 -Y2" }
    $down = @{ left = [CU.Native]::MOUSEEVENTF_LEFTDOWN; right = [CU.Native]::MOUSEEVENTF_RIGHTDOWN; middle = [CU.Native]::MOUSEEVENTF_MIDDLEDOWN }[$Button]
    $up = @{ left = [CU.Native]::MOUSEEVENTF_LEFTUP; right = [CU.Native]::MOUSEEVENTF_RIGHTUP; middle = [CU.Native]::MOUSEEVENTF_MIDDLEUP }[$Button]
    $steps = [math]::Max(8, [int]($DurationMs / 16))
    [CU.Native]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 60
    [CU.Native]::SendMouse($down, 0)
    Start-Sleep -Milliseconds 60
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / [double]$steps
      [CU.Native]::SetCursorPos([int][math]::Round($X + ($X2 - $X) * $t), [int][math]::Round($Y + ($Y2 - $Y) * $t)) | Out-Null
      Start-Sleep -Milliseconds ([math]::Max(8, [int]($DurationMs / $steps)))
    }
    Start-Sleep -Milliseconds 60
    [CU.Native]::SendMouse($up, 0)
    $result.from = @{ x = $X; y = $Y }
    $result.to = @{ x = $X2; y = $Y2 }
    $result.durationMs = $DurationMs
  }

  'scroll' {
    Invoke-TargetGuard $result
    if ($X -ne [int]::MinValue -and $Y -ne [int]::MinValue) {
      [CU.Native]::SetCursorPos($X, $Y) | Out-Null
      Start-Sleep -Milliseconds 30
    }
    $flag = if ($Axis -eq 'horizontal') { [CU.Native]::MOUSEEVENTF_HWHEEL } else { [CU.Native]::MOUSEEVENTF_WHEEL }
    $ticks = 120 * [math]::Abs($Amount)
    [int]$signed = if ($Amount -lt 0) { -$ticks } else { $ticks }
    [CU.Native]::SendMouse($flag, $signed)
    $result.axis = $Axis
    $result.amount = $Amount
  }

  'type' {
    Invoke-TargetGuard $result
    if ($null -eq $Text) { throw "type requires -Text" }
    $n = 0
    foreach ($ch in $Text.ToCharArray()) {
      [CU.Native]::SendUnicode($ch)
      $n++
      if ($DelayMs -gt 0) { Start-Sleep -Milliseconds $DelayMs }
    }
    $result.characters = $n
  }

  { $_ -in @('key', 'hotkey') } {
    Invoke-TargetGuard $result
    if (-not $Key) { throw "$Action requires -Key" }
    $parts = @($Key -split '\+' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($parts.Count -eq 0) { throw "Empty key specification" }
    for ($i = 0; $i -lt $parts.Count - 1; $i++) { Send-KeyName $parts[$i]; Start-Sleep -Milliseconds 10 }
    Send-KeyName $parts[-1]
    $result.pressed = $parts
  }

  'wait' {
    Invoke-TargetGuard $result
    if ($DurationMs -lt 0) { throw "wait requires a non-negative -DurationMs" }
    Start-Sleep -Milliseconds $DurationMs
    $result.durationMs = $DurationMs
  }

  default { throw "Unknown action: $Action" }
}

} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
  $exitCode = 1
}

if (-not $Quiet) { $result | ConvertTo-Json -Depth 6 -Compress }
exit $exitCode
