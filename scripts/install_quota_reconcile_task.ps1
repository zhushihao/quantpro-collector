# Registers (or removes) the Windows scheduled task that runs the 12-hour
# Cloudflare official-meter quota reconcile.
#
# Task name : QuantPro_QuotaReconcile
# Schedule  : every 12 hours (repetition interval), starting 5 minutes after
#             registration; runs only when the current user is logged on, so
#             the task inherits the user environment (CLOUDFLARE_API_TOKEN is
#             read from the USER scope at run time - the script reads it from
#             the process environment, never from any file).
# Action    : <repo>\.venv\Scripts\python.exe if present, otherwise the
#             python.exe resolved from PATH at registration time (absolute
#             path baked into the task action).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install_quota_reconcile_task.ps1
#   powershell -ExecutionPolicy Bypass -File install_quota_reconcile_task.ps1 -Remove
#
# ASCII only by design (Task Scheduler + cmd compatibility).

[CmdletBinding()]
param(
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$TaskName = "QuantPro_QuotaReconcile"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ReconcileScript = Join-Path $RepoRoot "scripts\cf_quota_meter_reconcile.py"

function Assert-SingleTaskRow {
    param([string]$Name)
    $tasks = @(Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
    if ($tasks.Count -ne 1) {
        throw ("Expected exactly 1 scheduled task named '{0}', found {1}" -f $Name, $tasks.Count)
    }
    return $tasks[0]
}

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Output ("Task '{0}' not present; nothing to remove." -f $TaskName)
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    $left = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $left) {
        throw ("Failed to remove task '{0}'." -f $TaskName)
    }
    Write-Output ("Removed scheduled task '{0}'." -f $TaskName)
    exit 0
}

if (-not (Test-Path $ReconcileScript)) {
    throw ("Reconcile script not found: {0}" -f $ReconcileScript)
}

# Resolve the Python interpreter: prefer the repo venv, fall back to PATH.
$venvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
if (Test-Path $venvPython) {
    $PythonExe = (Resolve-Path $venvPython).Path
} else {
    $resolved = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -eq $resolved) {
        throw "No .venv found and python.exe is not on PATH; cannot register the task."
    }
    $PythonExe = $resolved.Source
}

# Warn (never print the value) when the token is missing from the USER scope:
# a logon-triggered task inherits the user environment.
$tokenUser = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "User")
if ([string]::IsNullOrEmpty($tokenUser)) {
    Write-Warning ("CLOUDFLARE_API_TOKEN is not set in the USER environment scope. " +
        "The task runs in your logon session, so also set it for the current process " +
        "if you rely on a machine-wide wrapper. Register anyway; the reconcile will " +
        "exit 1 until the token is visible to your user environment.")
}

# Idempotent registration: drop any same-name task first, then register fresh.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    Write-Output ("Existing task '{0}' found; deleting before re-registration." -f $TaskName)
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument ('"{0}"' -f $ReconcileScript) `
    -WorkingDirectory $RepoRoot

# Omitting -RepetitionDuration leaves the repetition indefinite on modern
# Windows builds (this host: win32 10.0.26200).
$trigger = New-ScheduledTaskTrigger -Once `
    -At (Get-Date).AddMinutes(5) `
    -RepetitionInterval (New-TimeSpan -Hours 12)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

$description = "QuantPro Collector quota reconcile: pulls Cloudflare official meters " +
    "(D1 / Workers AI / Vectorize / subscriptions) every 12 hours, upserts " +
    "quota_circuit_state at the 95% line, writes reports/quota-reconcile/. " +
    "Exit 3 = official API failure (nothing written)."

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description $description `
    -Force | Out-Null

# Assert exactly one row exists after registration.
$task = Assert-SingleTaskRow -Name $TaskName
Write-Output ("Registered task '{0}'." -f $TaskName)
Write-Output ("  action    : {0} {1}" -f $task.Actions[0].Execute, $task.Actions[0].Arguments)
Write-Output ("  workdir   : {0}" -f $task.Actions[0].WorkingDirectory)
Write-Output ("  interval  : {0}" -f $task.Triggers[0].Repetition.Interval)
Write-Output ("  next run  : {0}" -f (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime)

exit 0
