<#
  dsh-aegisub-bridge trigger
  Sends WM_COMMAND menu IDs to a running Aegisub window to run the WHALE_BRIDGE
  automation macro, then waits for the macro to write its JSON output.

  This file is intentionally pure ASCII so Windows PowerShell 5.1 parses it
  correctly even without a BOM. The Chinese dialog title is assembled from
  code points to avoid embedding non-ASCII bytes.

  Parameters are supplied by lib/index.js; nothing here is machine-specific.
#>
param(
  [Parameter(Mandatory = $true)][string]$WhaleDir,
  [string]$MacroName = "WHALE_BRIDGE",
  [int]$TimeoutMs = 8000,
  [switch]$ForceRescan,
  [switch]$RescanOnly
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$DumpPath = Join-Path $WhaleDir "dump.json"
$ResultPath = Join-Path $WhaleDir "result.json"
$ErrorPath = Join-Path $WhaleDir "error.txt"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WhaleBr {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr hMenu);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr hMenu, int nPos);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetMenuString(IntPtr hMenu, uint uIDItem, StringBuilder lpString, int nMaxCount, uint uFlag);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr hMenu, int nPos);
  public static string Title(IntPtr h) { var t = new StringBuilder(1024); GetWindowText(h, t, 1024); return t.ToString(); }
  public static string Cls(IntPtr h) { var c = new StringBuilder(256); GetClassName(h, c, 256); return c.ToString(); }
  public static IntPtr FindTop(uint pidTarget, string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == pidTarget && Title(h).IndexOf(part) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> Kids(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h,l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static uint FindMenuIdByText(IntPtr hMenu, string part) {
    int n = GetMenuItemCount(hMenu);
    for (int i = 0; i < n; i++) {
      var sb = new StringBuilder(256);
      GetMenuString(hMenu, (uint)i, sb, 256, 0x400);
      uint id = GetMenuItemID(hMenu, i);
      IntPtr sub = GetSubMenu(hMenu, i);
      if (sb.ToString().IndexOf(part) >= 0 && id != 0xFFFFFFFF) return id;
      if (sub != IntPtr.Zero) {
        uint r = FindMenuIdByText(sub, part);
        if (r != 0xFFFFFFFF) return r;
      }
    }
    return 0xFFFFFFFF;
  }
}
"@

# "Automation Script Manager" in zh-CN, assembled from code points (keeps this file ASCII).
$zhDialog = -join @(0x81EA, 0x52A8, 0x5316, 0x811A, 0x672C, 0x7BA1, 0x7406, 0x5668 | ForEach-Object { [char]$_ })

function Find-BridgeDialog([uint32]$procId) {
  $h = [WhaleBr]::FindTop($procId, $zhDialog)
  if ($h -ne [IntPtr]::Zero) { return $h }
  return [WhaleBr]::FindTop($procId, "Automation Script Manager")
}

function Rescan-Automation([uint32]$procId, [IntPtr]$main) {
  $dlg = Find-BridgeDialog $procId
  $opened = $false
  if ($dlg -eq [IntPtr]::Zero) {
    # 0x3EDF is Aegisub's "Open automation script manager" command id.
    [void][WhaleBr]::PostMessage($main, 0x0111, [IntPtr]0x3EDF, [IntPtr]0)
    Start-Sleep -Milliseconds 1800
    $dlg = Find-BridgeDialog $procId
    $opened = $true
  }
  if ($dlg -eq [IntPtr]::Zero) { return $false }
  $kids = [WhaleBr]::Kids($dlg)
  $buttons = @()
  foreach ($k in $kids) { if ([WhaleBr]::Cls($k) -eq 'Button') { $buttons += $k } }
  if ($buttons.Count -ge 6) {
    # Button order differs between versions/languages; 4 = rescan, 5 = close on zh-CN.
    [void][WhaleBr]::PostMessage($buttons[4], 0x00F5, [IntPtr]0, [IntPtr]0)
    Start-Sleep -Milliseconds 3000
  }
  if ($opened -and $buttons.Count -ge 6) {
    [void][WhaleBr]::PostMessage($buttons[5], 0x00F5, [IntPtr]0, [IntPtr]0)
    Start-Sleep -Milliseconds 600
  }
  return $true
}

$proc = Get-Process aegisub -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
if (-not $proc) { $proc = Get-Process aegisub -ErrorAction SilentlyContinue | Select-Object -First 1 }
if (-not $proc) { Write-Output "ERR:AEGISUB_NOT_RUNNING"; exit 1 }

$main = $proc.MainWindowHandle
$procId = [uint32]$proc.Id
if ($main -eq [IntPtr]::Zero) { Write-Output "ERR:NO_MAIN_WINDOW"; exit 1 }

if ($RescanOnly) {
  [void](Rescan-Automation $procId $main)
  Write-Output "OK:RESCAN"
  exit 0
}

if ($ForceRescan) { [void](Rescan-Automation $procId $main) }

$mid = [WhaleBr]::FindMenuIdByText([WhaleBr]::GetMenu($main), $MacroName)
if ($mid -eq 0xFFFFFFFF) {
  [void](Rescan-Automation $procId $main)
  $mid = [WhaleBr]::FindMenuIdByText([WhaleBr]::GetMenu($main), $MacroName)
}
if ($mid -eq 0xFFFFFFFF) { Write-Output "ERR:MACRO_NOT_FOUND"; exit 1 }

$oldMtime = $null
if (Test-Path $DumpPath) { $oldMtime = (Get-Item $DumpPath).LastWriteTimeUtc }
try { Remove-Item $ErrorPath -Force -ErrorAction SilentlyContinue } catch {}

[void][WhaleBr]::PostMessage($main, 0x0111, [IntPtr]$mid, [IntPtr]0)

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$changed = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 150
  if (Test-Path $DumpPath) {
    $cur = (Get-Item $DumpPath).LastWriteTimeUtc
    if ($oldMtime -eq $null -or $cur -ne $oldMtime) { $changed = $true; break }
  }
}
if (-not $changed) { Write-Output "ERR:TIMEOUT"; exit 2 }
if (Test-Path $ErrorPath) { Write-Output ("ERR:LUA:" + (Get-Content $ErrorPath -Raw)); exit 3 }

Write-Output "OK"
Write-Output ("DUMP=" + $DumpPath)
if (Test-Path $ResultPath) { Write-Output ("RESULT=" + (Get-Content $ResultPath -Raw)) }
