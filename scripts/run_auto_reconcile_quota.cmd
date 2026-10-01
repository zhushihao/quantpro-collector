REM Silent launcher for the autonomous quota reconcile (issue #54 stage 3).
REM Runs scripts/auto_reconcile_quota.py every 12h via QuantPro_QuotaAutoReconcile.
REM
REM The token is NOT stored here: the scheduled task runs as the interactive user
REM and inherits the user-level CLOUDFLARE_API_TOKEN environment variable, so no
REM credential ever lands in the repository or in the task definition.
REM
REM Exit code discipline: the Python script returns 0 on success and non-zero on
REM any abort (it writes nothing on abort).  The redirect below keeps a plain
REM stdout/stderr tail next to the script's own JSON line log.
setlocal
cd /d "%~dp0.."
python "%~dp0auto_reconcile_quota.py" 1>>"%~dp0..\logs\quota-auto-reconcile.out" 2>&1
exit /b %ERRORLEVEL%
