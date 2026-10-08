# Native Windows install: irm https://herdrweb.dev/install.ps1 | iex
param([string]$Ref = $env:HERDR_WEB_UI_REF)

& {
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'herdr web ui supports Windows x64. Use install.sh on Linux or macOS.'
}

function Run-Tool([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Tool failed (exit $LASTEXITCODE). Fix the error above and run this again." }
}
function Run-HerdrInstaller([string]$Installer) {
    # Its errors join its output, so a failed download can be told from a silent stop. Under Stop,
    # Windows PowerShell would end this script at the first line curl writes to stderr.
    $ErrorActionPreference = 'Continue'
    & $Installer 2>&1 | ForEach-Object { $line = "$_"; Write-Host $line; $line }
}

# The official installers keep these user-local directories on PATH for future terminals.
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Install Git for Windows (https://git-scm.com/download/win), then run this again.'
}
if (-not (Get-Command herdr -ErrorAction SilentlyContinue)) {
    Write-Host 'herdr web ui: installing herdr for your user'
    $installer = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName() + '.cmd')
    try {
        Invoke-WebRequest 'https://herdr.dev/install.cmd' -UseBasicParsing -OutFile $installer
        # herdr's installer gives up on a download that stays under 1 KB/s for 30 seconds.
        $download = 'curl: \(\d+\)|Failed to download'
        $output = @(Run-HerdrInstaller $installer)
        if ($LASTEXITCODE -ne 0 -and ($output -match $download)) {
            Write-Host "herdr web ui: herdr's download did not finish; trying once more"
            $output = @(Run-HerdrInstaller $installer)
        }
        if ($LASTEXITCODE -ne 0) {
            if ($output -match $download) { throw "herdr could not be downloaded: the connection was too slow or was cut off (curl's message is above). Run this again, on another network if it keeps failing, or install herdr from https://herdr.dev first." }
            # Seen stopping without a message of its own on a PC with banking security software.
            throw "herdr's installer did not finish. If it showed no error, security software may have stopped it: install herdr from https://herdr.dev, then run this again."
        }
    } finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
}
$herdrVersion = (Run-Tool herdr @('--version')) -replace '^herdr\s+', '' -replace '-.*$', ''
if ([version]$herdrVersion -lt [version]'0.9.0') {
    throw "Needs herdr 0.9.0 or newer; this is $herdrVersion. Update herdr and run this again."
}

$bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bun -or [version]((Run-Tool bun @('--version')) -replace '-.*$', '') -lt [version]'1.4.0') {
    Write-Host 'herdr web ui: installing Bun 1.4.2 for your user'
    # The same stable runtime as CI; use Bun's official installer rather than a second downloader.
    # It leaves this session with the user's PATH alone: without the machine's, neither this script nor herdr finds git.
    $path = $env:PATH
    & ([scriptblock]::Create((Invoke-WebRequest 'https://bun.sh/install.ps1' -UseBasicParsing).Content)) -Version '1.4.2'
    $env:PATH = $path
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { throw 'Bun did not install. See https://bun.sh.' }
$bunVersion = Run-Tool bun @('--version')
if ([version]($bunVersion -replace '-.*$', '') -lt [version]'1.4.0') { throw "Needs Bun 1.4 or newer; this is $bunVersion." }

$pluginId = 'devswha.herdr-web-ui'
function Find-Plugin {
    (Run-Tool herdr @('plugin', 'list', '--json') | ConvertFrom-Json).result.plugins |
        Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
}
function Test-WindowsPlugin($Plugin) {
    $Plugin.plugin_root -and (Test-Path -LiteralPath (Join-Path $Plugin.plugin_root 'scripts\plugin.ps1'))
}
$plugin = Find-Plugin
$newInstall = $false
if ($plugin -and -not (Test-WindowsPlugin $plugin)) {
    # A copy from a release older than Windows support never starts here, so no in-app update reaches it.
    Write-Host 'herdr web ui: replacing an installed copy that has no Windows support'
    Run-Tool herdr @('plugin', 'uninstall', $pluginId) | Out-Null
    $plugin = $null
}
if (-not $plugin) {
    if (-not $Ref) {
        $Ref = Run-Tool git @('ls-remote', '--tags', '--refs', 'https://github.com/devswha/herdr-web-ui.git', 'v*') |
            ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
            Sort-Object { [version]$_.Substring(1) } | Select-Object -Last 1
    }
    if (-not $Ref) { throw 'Could not find the latest app release on GitHub. Check your connection and run this again.' }
    Write-Host "herdr web ui: installing the plugin at $Ref"
    Run-Tool herdr @('plugin', 'install', 'devswha/herdr-web-ui', '--ref', $Ref, '--yes')
    $newInstall = $true
    $plugin = Find-Plugin
    if (-not $plugin.plugin_root) { throw 'herdr does not list the plugin after installing it. See: herdr plugin list' }
    # herdr installs a release without Windows build steps as a success that cannot start.
    if (-not (Test-WindowsPlugin $plugin)) { throw "herdr web ui $Ref does not support Windows yet. Run this again after the next release." }
} else { Write-Host 'herdr web ui: already installed; Settings > Updates keeps it current' }

$server = Run-Tool herdr @('status', 'server', '--json') | ConvertFrom-Json
if ($server.running) {
    Run-Tool herdr @('plugin', 'action', 'invoke', "$pluginId.start-windows") | Out-Null
    $script = Join-Path $plugin.plugin_root 'scripts\plugin.ts'
    $ready = $false
    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        $status = Run-Tool bun @($script, 'status')
        if ($status -match '^running ') { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) {
        # The start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal.
        $why = ''
        try {
            $failed = (& herdr plugin log list | ConvertFrom-Json).result.logs |
                Where-Object { $_.plugin_id -eq $pluginId -and $_.stderr } | Select-Object -Last 1
            if ($failed) { $why = "`n" + $failed.stderr.Trim() }
        } catch { $why = '' } # the reason is a help, not a step: without it the pointer below still stands
        throw "The app did not start within 25 seconds.$why`nSee: herdr plugin log list"
    }
    Write-Host ($status | Where-Object { $_ -match '^running ' })
} else { Write-Host 'herdr web ui: starts with herdr. Open a new terminal and run: herdr' }
Write-Host 'herdr web ui: open Phone setup in herdr for phone access.'

# One gh api call: gh's exit code and the HTTP status GitHub answered with, or nothing when gh is
# not there or does not answer in 10 seconds. A gh that hangs must not hold up an install that is done:
# the deadline covers its exit and its output both (a child it handed the output to could live on),
# and what outlasts it is killed with its children.
function Invoke-GhApi([string]$Arguments) {
    $gh = Get-Command gh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $gh) { return }
    $start = New-Object Diagnostics.ProcessStartInfo
    $ghArguments = "api --hostname github.com --include $Arguments"
    if ($gh.Path -match '\.(cmd|bat)$') {
        # a shim: the command interpreter runs it, with the path and the arguments as one quoted command
        $start.FileName = $env:ComSpec
        $start.Arguments = "/d /c """"$($gh.Path)"" $ghArguments"""
    } else {
        $start.FileName = $gh.Path
        $start.Arguments = $ghArguments
    }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($start)
        $process.StandardInput.Close()
        $said = $process.StandardOutput.ReadToEndAsync()
        $null = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(10000) -or -not $said.Wait(2000)) {
            try { & $env:ComSpec /d /c "taskkill /T /F /PID $($process.Id) >nul 2>&1" } catch { }
            return
        }
        $status = ''
        if ($said.Result -match '^HTTP\S* (\d{3})') { $status = $Matches[1] }
        @{ code = $process.ExitCode; status = $status }
    } finally { if ($process) { $process.Dispose() } }
}
# A script that runs this has nobody to answer. A terminal can have nobody at it either (an agent's),
# so the answer is read key by key within 20 seconds in all: what was typed before the question is
# discarded, and a line left unfinished when the time is up is no answer.
function Test-Terminal { -not ($env:CI -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) }
function Read-Answer {
    $Host.UI.RawUI.FlushInputBuffer()
    $until = (Get-Date).AddSeconds(20)
    $answer = ''
    while ((Get-Date) -lt $until) {
        if (-not [Console]::KeyAvailable) { Start-Sleep -Milliseconds 100; continue }
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq [ConsoleKey]::Enter) { Write-Host ''; return $answer }
        if ($key.Key -eq [ConsoleKey]::Backspace) {
            if ($answer.Length -gt 0) { $answer = $answer.Substring(0, $answer.Length - 1); Write-Host -NoNewline "`b `b" }
        } elseif (-not [char]::IsControl($key.KeyChar)) {
            $answer += $key.KeyChar
            Write-Host -NoNewline $key.KeyChar
        }
    }
    Write-Host ''
    return $null
}
# Once, on the first install, and not to an account that already starred (204). It asks only when
# GitHub says the account has not (404), only at a terminal, and stars only on "y".
if ($newInstall) {
    try {
        $starred = Invoke-GhApi 'user/starred/devswha/herdr-web-ui'
        if (-not $starred -or $starred.status -ne '204') {
            Write-Host ''
            Write-Host 'herdr web ui: if it helps you, a GitHub star helps other herdr users find it: https://github.com/devswha/herdr-web-ui'
            if ($starred -and $starred.status -eq '404' -and (Test-Terminal)) {
                Write-Host -NoNewline 'herdr web ui: star it now with the GitHub account gh is signed in to? [y/N] '
                $answer = Read-Answer
                if ("$answer".Trim() -match '^(y|yes)$') {
                    $given = Invoke-GhApi '--method PUT user/starred/devswha/herdr-web-ui'
                    if ($given -and $given.code -eq 0) { Write-Host 'herdr web ui: starred. Thank you!' }
                    else { Write-Host 'herdr web ui: gh could not star it; the page above can' }
                }
            }
        }
    } catch { } # the install is done by now: a question that cannot be asked must not fail it
}
}
