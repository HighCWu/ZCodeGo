# zcode-go plugin bootstrap (Windows): locate the official Electron binary
# via the parent process chain and run the plugin CJS with ELECTRON_RUN_AS_NODE=1.
# Invoked from hooks.json fallback chain (`sh bootstrap.sh || powershell ... bootstrap.ps1`).
$ErrorActionPreference = "Stop"
$hookCjs = Join-Path $PSScriptRoot "zcode-go.cjs"

function Get-ProcInfo([int]$Pid_) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$Pid_" -ErrorAction Stop
    if ($null -eq $p) { return $null }
    return @{ ppid = [int]$p.ParentProcessId; exe = [string]$p.ExecutablePath }
  } catch { return $null }
}

$exe = ""
$pid_ = $PID
$seen = @{}
for ($depth = 0; $depth -lt 64 -and $pid_ -gt 0; $depth++) {
  if ($seen.ContainsKey($pid_)) { break }
  $seen[$pid_] = $true
  $info = Get-ProcInfo $pid_
  if ($null -eq $info) { break }
  # 祖先可能无可执行路径（系统/包装进程，Win32_Process.ExecutablePath 为空）：
  # Split-Path 空串是终止错误，EAP=Stop 下会杀掉整个脚本 → hook 零输出 →
  # fail-open 放行 prompt（windows takeover 未拦截的根因）。跳过该层继续上溯。
  $exePath = [string]$info.exe
  if (-not [string]::IsNullOrWhiteSpace($exePath)) {
    $name = Split-Path -Leaf $exePath
    if ($name -match "(?i)zcode" -and $name -notmatch "(?i)zcode[-_]go") {
      $exe = $exePath
      break
    }
  }
  $pid_ = $info.ppid
}

if (-not $exe -or -not (Test-Path $exe)) {
  [Console]::Error.WriteLine("zcode-go bootstrap: official binary not found in ancestors")
  exit 3
}

$env:ELECTRON_RUN_AS_NODE = "1"
& $exe $hookCjs hook
exit $LASTEXITCODE
