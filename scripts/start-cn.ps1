param(
    [int]$Port = 8001,
    [switch]$RestartOwned,
    [switch]$NoBuild,
    [switch]$CheckOnly,
    [switch]$FunctionsOnly
)

$ErrorActionPreference = 'Stop'

function Get-ListeningProcess {
    param([Parameter(Mandatory = $true)][int]$Port)

    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) { return $null }
    $ids = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($ids.Count -ne 1) {
        throw "Port $Port has multiple listening owners: $($ids -join ', ')"
    }
    return Get-Process -Id $ids[0] -ErrorAction Stop
}

function Get-ProcessCommandLine {
    param([Parameter(Mandatory = $true)][int]$ProcessId)

    $record = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$record.CommandLine
}

function Test-StarPointProcess {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($process.ProcessName -ne 'node') { return $false }
    $command = (Get-ProcessCommandLine -ProcessId $ProcessId).Replace('/', '\')
    $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'out\cn-server.js'))
    return $command.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Read-OwnedPidRecord {
    param([Parameter(Mandatory = $true)][string]$PidFile)

    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }
    try {
        $record = Get-Content -LiteralPath $PidFile -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        throw "Invalid StarPoint PID record: $PidFile ($($_.Exception.Message))"
    }
    if ($record.schema_version -ne 1 -or [string]$record.pid -notmatch '^[1-9][0-9]*$' -or -not $record.entry) {
        throw "Invalid StarPoint PID record: $PidFile"
    }
    return $record
}

function Test-OwnedListener {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$PidFile
    )

    $record = Read-OwnedPidRecord -PidFile $PidFile
    if ($null -eq $record -or [int]$record.pid -ne $ProcessId) { return $false }
    $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot 'out\cn-server.js'))
    $recordEntry = [IO.Path]::GetFullPath([string]$record.entry)
    if (-not $recordEntry.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return Test-StarPointProcess -ProcessId $ProcessId -RepoRoot $RepoRoot
}

function Assert-OwnedListener {
    param(
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$PidFile
    )

    if (-not (Test-OwnedListener -ProcessId $ProcessId -RepoRoot $RepoRoot -PidFile $PidFile)) {
        $name = (Get-Process -Id $ProcessId -ErrorAction Stop).ProcessName
        $command = Get-ProcessCommandLine -ProcessId $ProcessId
        throw "Refusing to stop foreign listener PID=$ProcessId name=$name command=$command"
    }
}

function Test-BuildRequired {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    $output = Join-Path $RepoRoot 'out\cn-server.js'
    $stamp = Join-Path $RepoRoot 'out\.cn-server-build-stamp'
    if (-not (Test-Path -LiteralPath $output -PathType Leaf) -or
        -not (Test-Path -LiteralPath $stamp -PathType Leaf)) { return $true }
    $buildTime = (Get-Item -LiteralPath $stamp).LastWriteTimeUtc
    $inputs = @(
        (Join-Path $RepoRoot 'package.json'),
        (Join-Path $RepoRoot 'package-lock.json'),
        (Join-Path $RepoRoot 'tsconfig.json')
    ) + @(Get-ChildItem -LiteralPath (Join-Path $RepoRoot 'src') -Recurse -File -Filter '*.ts' |
        Select-Object -ExpandProperty FullName)
    foreach ($inputPath in $inputs) {
        if ((Get-Item -LiteralPath $inputPath).LastWriteTimeUtc -gt $buildTime) { return $true }
    }
    return $false
}

function Assert-BuildPolicy {
    param(
        [Parameter(Mandatory = $true)][bool]$BuildRequired,
        [Parameter(Mandatory = $true)][bool]$NoBuild
    )

    if ($BuildRequired -and $NoBuild) {
        throw 'Build output is missing or stale; rerun without -NoBuild'
    }
}

function Assert-Environment {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)

    foreach ($name in @('node', 'npm')) {
        if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
            throw "$name is not available in PATH"
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.env') -PathType Leaf)) {
        throw '.env is missing; copy .env.example and configure it first'
    }
    $nodeVersion = [version](& node -p 'process.versions.node')
    if ($nodeVersion -lt [version]'20.19.0') {
        throw "Node 20.19.0+ is required; found $nodeVersion"
    }
}

function Write-OwnedPidRecord {
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    $directory = Split-Path -Parent $PidFile
    $null = New-Item -ItemType Directory -Path $directory -Force
    $temporary = Join-Path $directory (".{0}.{1}.tmp" -f [IO.Path]::GetFileName($PidFile), [guid]::NewGuid().ToString('N'))
    $record = [ordered]@{
        schema_version = 1
        pid = $ProcessId
        entry = [IO.Path]::GetFullPath($Entry)
        started_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    try {
        [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        # [IO.File]::Replace throws "path is not of a legal form" on PS 5.1 when the
        # pid file already exists, and the failure tears down the freshly started
        # server via the caller's finally block. Delete-then-move avoids it.
        if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
            Remove-Item -LiteralPath $PidFile -Force
        }
        [IO.File]::Move($temporary, $PidFile)
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Remove-OwnedPidRecord {
    param(
        [Parameter(Mandatory = $true)][string]$PidFile,
        [Parameter(Mandatory = $true)][int]$ProcessId,
        [Parameter(Mandatory = $true)][string]$Entry
    )

    try {
        $record = Read-OwnedPidRecord -PidFile $PidFile
        if ($null -eq $record -or [int]$record.pid -ne $ProcessId) { return }
        $expected = [IO.Path]::GetFullPath($Entry)
        $actual = [IO.Path]::GetFullPath([string]$record.entry)
        if ($actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $PidFile -Force
        }
    } catch {
        Write-Warning "PID record was not removed because it could not be verified: $($_.Exception.Message)"
    }
}

if ($FunctionsOnly) { return }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = [IO.Path]::GetFullPath((Join-Path $repoRoot 'out\cn-server.js'))
$envFile = [IO.Path]::GetFullPath((Join-Path $repoRoot '.env'))
$pidFile = [IO.Path]::GetFullPath((Join-Path $repoRoot 'work\run\cn-server.pid.json'))

try {
    Assert-Environment -RepoRoot $repoRoot
    $listener = Get-ListeningProcess -Port $Port
    if ($listener) {
        Assert-OwnedListener -ProcessId $listener.Id -RepoRoot $repoRoot -PidFile $pidFile
        if ($CheckOnly) {
            Write-Host "[PORT] $Port is owned by this StarPoint instance (PID $($listener.Id))"
        } elseif (-not $RestartOwned) {
            throw "Port $Port is owned by this StarPoint instance (PID $($listener.Id)); use -RestartOwned to restart it"
        } else {
            Write-Host "[PORT] stopping owned StarPoint listener PID=$($listener.Id)"
            Stop-Process -Id $listener.Id -Force
            Wait-Process -Id $listener.Id -Timeout 15 -ErrorAction SilentlyContinue
            Remove-OwnedPidRecord -PidFile $pidFile -ProcessId $listener.Id -Entry $entry
        }
    } else {
        Write-Host "[PORT] $Port is available"
    }

    $buildRequired = Test-BuildRequired -RepoRoot $repoRoot
    Assert-BuildPolicy -BuildRequired $buildRequired -NoBuild ([bool]$NoBuild)
    if ($buildRequired) {
        Write-Host '[BUILD] output is missing or stale; building server and CSS'
    } else {
        Write-Host '[BUILD] output is current'
    }

    if ($CheckOnly) {
        Write-Host '[CHECK] environment, ownership, and build checks passed'
        exit 0
    }

    if ($buildRequired) {
        Push-Location $repoRoot
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
    }

    $node = Get-Command node -ErrorAction Stop
    $arguments = @("--env-file=`"$envFile`"", "`"$entry`"")
    Write-Host "[START] StarPoint CN http://127.0.0.1:$Port"
    $hadListenPort = Test-Path Env:CN_LISTEN_PORT
    $previousListenPort = $env:CN_LISTEN_PORT
    try {
        $env:CN_LISTEN_PORT = [string]$Port
        $server = Start-Process -FilePath $node.Source -ArgumentList $arguments -WorkingDirectory $repoRoot -NoNewWindow -PassThru
    } finally {
        if ($hadListenPort) {
            $env:CN_LISTEN_PORT = $previousListenPort
        } else {
            Remove-Item Env:CN_LISTEN_PORT -ErrorAction SilentlyContinue
        }
    }
    try {
        Write-OwnedPidRecord -PidFile $pidFile -ProcessId $server.Id -Entry $entry
        $server.WaitForExit()
        $exitCode = $server.ExitCode
    } finally {
        if ($server -and -not $server.HasExited) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $server.Id -Timeout 15 -ErrorAction SilentlyContinue
        }
        if ($server) {
            Remove-OwnedPidRecord -PidFile $pidFile -ProcessId $server.Id -Entry $entry
        }
    }
    Write-Host "[EXIT] server stopped with exit code $exitCode"
    exit $exitCode
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
