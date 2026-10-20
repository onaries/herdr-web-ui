# Herdr may have started before Bun was installed: read the current user PATH at invocation time.
param([string]$Command = 'status')
$ErrorActionPreference = 'Stop'
if (-not $env:HOME) { $env:HOME = $env:USERPROFILE }
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:PATH = "$env:USERPROFILE\.bun\bin;$userPath;$env:PATH"
if ($Command -eq 'start') {
    # A fresh hidden console keeps PowerShell's output pipes out of the detached server.
    $child = Start-Process -FilePath (Get-Command bun).Source -ArgumentList ('"{0}" start' -f (Join-Path $PSScriptRoot 'plugin.ts')) -WindowStyle Hidden -PassThru
    $null = $child.Handle # Keep the exit code available even when start exits quickly.
    $child.WaitForExit() # -Wait would also wait for the server's descendants.
    if ($child.ExitCode -ne 0) {
        # The hidden console took the start's own words; server.log holds them and the server's.
        $log = Join-Path $env:HERDR_PLUGIN_STATE_DIR 'server.log'
        $tail = if (Test-Path -LiteralPath $log) { (Get-Content -LiteralPath $log -Tail 15) -join "`n" } else { '(no log)' }
        throw "Could not start Ovis. $log ends with:`n$tail"
    }
    Write-Output 'Ovis started'
    exit 0
}
& bun (Join-Path $PSScriptRoot 'plugin.ts') $Command
exit $LASTEXITCODE
