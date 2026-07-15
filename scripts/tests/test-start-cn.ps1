$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$launcher = Join-Path $repo 'scripts\start-cn.ps1'
. $launcher -FunctionsOnly

$script:passed = 0

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) { throw "Assertion failed: $Message" }
    $script:passed++
    Write-Host "[PASS] $Message"
}

function Assert-Throws {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$ExpectedMessage
    )
    try {
        & $Action
    } catch {
        if ($ExpectedMessage -and $_.Exception.Message -notlike "*$ExpectedMessage*") {
            throw "Assertion failed: $Message (unexpected error: $($_.Exception.Message))"
        }
        $script:passed++
        Write-Host "[PASS] $Message"
        return
    }
    throw "Assertion failed: $Message (no error was thrown)"
}

function Wait-ForListener {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][int]$ProcessId
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ((Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and
            (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
            return
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Listener fixture did not start on port $Port (PID $ProcessId)"
}

function Write-TextFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        $null = New-Item -ItemType Directory -Path $directory -Force
    }
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

$node = Get-Command node -ErrorAction Stop
$testRoot = Join-Path $env:TEMP ("startpoint-launcher-test-{0}" -f [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot
$processes = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

try {
    Assert-True ($null -eq (Get-ListeningProcess -Port 18003)) 'no listener returns null'

    $foreignScript = Join-Path $testRoot 'foreign.js'
    Write-TextFile -Path $foreignScript -Content 'require("net").createServer().listen(18001); setInterval(()=>{},1000)'
    $foreign = Start-Process -FilePath $node.Source -ArgumentList @($foreignScript) -WindowStyle Hidden -PassThru
    $processes.Add($foreign)
    Wait-ForListener -Port 18001 -ProcessId $foreign.Id
    $owner = Get-ListeningProcess -Port 18001
    Assert-True ($owner.Id -eq $foreign.Id) 'test fixture owns port 18001'
    $missingPidFile = Join-Path $testRoot 'missing-pid.json'
    Assert-Throws { Assert-OwnedListener -ProcessId $owner.Id -RepoRoot $repo -PidFile $missingPidFile } 'foreign listener is refused' 'Refusing to stop foreign listener'
    Assert-True (-not $foreign.HasExited) 'foreign listener remains alive after refusal'

    $ownedRoot = Join-Path $testRoot 'owned-repo'
    $ownedEntry = Join-Path $ownedRoot 'out\cn-server.js'
    Write-TextFile -Path $ownedEntry -Content 'require("net").createServer().listen(Number(process.argv[2])); setInterval(()=>{},1000)'
    $owned = Start-Process -FilePath $node.Source -ArgumentList @($ownedEntry, '18002') -WindowStyle Hidden -PassThru
    $processes.Add($owned)
    Wait-ForListener -Port 18002 -ProcessId $owned.Id
    $pidFile = Join-Path $testRoot 'owned.pid.json'

    $validRecord = [ordered]@{
        schema_version = 1
        pid = $owned.Id
        entry = [IO.Path]::GetFullPath($ownedEntry)
        started_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    Write-TextFile -Path $pidFile -Content ($validRecord | ConvertTo-Json)
    Assert-True (Test-OwnedListener -ProcessId $owned.Id -RepoRoot $ownedRoot -PidFile $pidFile) 'matching PID, entry, and command identify an owned listener'

    $stale = [ordered]@{
        schema_version = 1
        pid = $owned.Id + 1
        entry = [IO.Path]::GetFullPath($ownedEntry)
        started_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    Write-TextFile -Path $pidFile -Content ($stale | ConvertTo-Json)
    Assert-True (-not (Test-OwnedListener -ProcessId $owned.Id -RepoRoot $ownedRoot -PidFile $pidFile)) 'stale PID record is rejected'

    $forged = [ordered]@{
        schema_version = 1
        pid = $owned.Id
        entry = Join-Path $ownedRoot 'out\server.js'
        started_at_utc = [DateTime]::UtcNow.ToString('o')
    }
    Write-TextFile -Path $pidFile -Content ($forged | ConvertTo-Json)
    Assert-True (-not (Test-OwnedListener -ProcessId $owned.Id -RepoRoot $ownedRoot -PidFile $pidFile)) 'forged entry record is rejected'

    Write-TextFile -Path $pidFile -Content '{broken json'
    Assert-Throws { Read-OwnedPidRecord -PidFile $pidFile } 'corrupt PID record is rejected'
    Assert-True (-not $owned.HasExited) 'owned fixture remains alive during record validation tests'

    $buildRoot = Join-Path $testRoot 'build-repo'
    $output = Join-Path $buildRoot 'out\cn-server.js'
    $buildStamp = Join-Path $buildRoot 'out\.cn-server-build-stamp'
    $source = Join-Path $buildRoot 'src\nested\server.ts'
    $packageJson = Join-Path $buildRoot 'package.json'
    $packageLock = Join-Path $buildRoot 'package-lock.json'
    $tsconfig = Join-Path $buildRoot 'tsconfig.json'
    foreach ($path in @($output, $buildStamp, $source, $packageJson, $packageLock, $tsconfig)) {
        Write-TextFile -Path $path -Content '{}'
    }
    $old = [DateTime]::UtcNow.AddMinutes(-5)
    $outputOld = [DateTime]::UtcNow.AddMinutes(-10)
    $fresh = [DateTime]::UtcNow.AddMinutes(-1)
    foreach ($path in @($source, $packageJson, $packageLock, $tsconfig)) {
        (Get-Item -LiteralPath $path).LastWriteTimeUtc = $old
    }
    (Get-Item -LiteralPath $output).LastWriteTimeUtc = $outputOld
    (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc = $fresh
    Assert-True (-not (Test-BuildRequired -RepoRoot $buildRoot)) 'successful build stamp accepts unchanged incremental output'

    foreach ($input in @($source, $packageJson, $packageLock, $tsconfig)) {
        (Get-Item -LiteralPath $input).LastWriteTimeUtc = [DateTime]::UtcNow
        Assert-True (Test-BuildRequired -RepoRoot $buildRoot) "newer input requires a build: $([IO.Path]::GetFileName($input))"
        (Get-Item -LiteralPath $input).LastWriteTimeUtc = $old
    }
    Remove-Item -LiteralPath $buildStamp -Force
    Assert-True (Test-BuildRequired -RepoRoot $buildRoot) 'missing build stamp requires a build'
    Write-TextFile -Path $buildStamp -Content '{}'
    (Get-Item -LiteralPath $buildStamp).LastWriteTimeUtc = $fresh
    Remove-Item -LiteralPath $output -Force
    Assert-True (Test-BuildRequired -RepoRoot $buildRoot) 'missing build output requires a build'
    Assert-Throws { Assert-BuildPolicy -BuildRequired $true -NoBuild $true } '-NoBuild rejects stale output' 'stale'

    $environmentRoot = Join-Path $testRoot 'missing-env'
    $null = New-Item -ItemType Directory -Path $environmentRoot
    Assert-Throws { Assert-Environment -RepoRoot $environmentRoot } 'missing .env has an actionable error' '.env is missing'
} finally {
    foreach ($process in $processes) {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

Write-Host "[OK] $script:passed launcher assertions passed"
