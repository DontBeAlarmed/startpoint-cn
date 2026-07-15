$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0


function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}


function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "$Message (expected=$Expected actual=$Actual)"
    }
}


function Invoke-Generator {
    param([string]$ScriptPath, [string[]]$Arguments = @())
    $shell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $shell
    $info.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $ScriptPath + '"'
    if ($Arguments.Count -gt 0) { $info.Arguments += " " + ($Arguments -join " ") }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $result = [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
    }
    $process.Dispose()
    return $result
}


function Read-Token {
    param([string]$EnvPath)
    $content = [IO.File]::ReadAllText($EnvPath)
    $match = [regex]::Match($content, '(?m)^CN_ADMIN_TOKEN="(?<token>[0-9a-f]{64})"\r?$')
    Assert-True $match.Success "generated token line is missing or malformed"
    return $match.Groups["token"].Value
}


$sourceScript = Join-Path (Split-Path -Parent $PSScriptRoot) "generate-admin-token.ps1"
Assert-True (Test-Path -LiteralPath $sourceScript -PathType Leaf) "generator script is missing"

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$tempRoot = Join-Path $tempBase ("wf-admin-token-tests-" + [Guid]::NewGuid().ToString("N"))
$scriptsDir = Join-Path $tempRoot "scripts"
$copyPath = Join-Path $scriptsDir "generate-admin-token.ps1"
$envPath = Join-Path $tempRoot ".env"
$utf8 = New-Object Text.UTF8Encoding($false)

try {
    [void](New-Item -ItemType Directory -Path $scriptsDir)
    Copy-Item -LiteralPath $sourceScript -Destination $copyPath
    [IO.File]::WriteAllText($envPath, "CN_LISTEN_HOST=`"127.0.0.1`"`r`n", $utf8)
    $initialBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))

    $dryRun = Invoke-Generator $copyPath @("-WhatIf")
    Assert-Equal 0 $dryRun.ExitCode "WhatIf should succeed"
    Assert-Equal $initialBytes ([Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))) "WhatIf changed .env"
    Assert-True ($dryRun.Stdout -match 'fingerprint=[0-9a-f]{12}') "WhatIf did not print a fingerprint"
    Assert-True ($dryRun.Stdout -notmatch '[0-9a-f]{64}') "WhatIf printed token-shaped output"

    $created = Invoke-Generator $copyPath
    Assert-Equal 0 $created.ExitCode "initial generation should succeed"
    $firstToken = Read-Token $envPath
    $firstOutput = $created.Stdout + $created.Stderr
    Assert-True (-not $firstOutput.Contains($firstToken)) "initial generation echoed the token"
    Assert-True ($created.Stdout -match 'fingerprint=[0-9a-f]{12}') "generation did not print a fingerprint"
    Assert-True ([IO.File]::ReadAllText($envPath).Contains('CN_LISTEN_HOST="127.0.0.1"')) "existing .env content was not preserved"

    $acl = Get-Acl -LiteralPath $envPath
    Assert-True $acl.AreAccessRulesProtected ".env ACL still inherits permissions"
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $expectedSids = @(
        [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
        "S-1-5-18"
    ) | Sort-Object -Unique
    $actualSids = @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    Assert-Equal ($expectedSids -join ',') ($actualSids -join ',') ".env ACL contains unexpected identities"
    foreach ($rule in $rules) {
        Assert-Equal "Allow" $rule.AccessControlType.ToString() ".env ACL contains a deny rule"
        Assert-True (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) ".env ACL is not FullControl"
    }

    $beforeDuplicate = [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))
    $duplicate = Invoke-Generator $copyPath
    Assert-True ($duplicate.ExitCode -ne 0) "duplicate generation should fail"
    Assert-True ($beforeDuplicate -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))) "duplicate generation changed .env"
    Assert-True (-not ($duplicate.Stdout + $duplicate.Stderr).Contains($firstToken)) "duplicate error echoed the token"

    $rotated = Invoke-Generator $copyPath @("-Rotate")
    Assert-Equal 0 $rotated.ExitCode "rotation should succeed"
    $secondToken = Read-Token $envPath
    Assert-True ($secondToken -ne $firstToken) "rotation reused the previous token"
    $rotateOutput = $rotated.Stdout + $rotated.Stderr
    Assert-True (-not $rotateOutput.Contains($firstToken)) "rotation echoed the old token"
    Assert-True (-not $rotateOutput.Contains($secondToken)) "rotation echoed the new token"
    Assert-Equal 0 @(Get-ChildItem -LiteralPath $tempRoot -Force -Filter '.env.wf-admin-token.*.tmp').Count "owned temporary file was left behind"

    $beforeFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))
    [IO.File]::SetAttributes($envPath, [IO.FileAttributes]::ReadOnly)
    try {
        $failedReplace = Invoke-Generator $copyPath @("-Rotate")
        Assert-True ($failedReplace.ExitCode -ne 0) "replacement of a read-only .env should fail"
        Assert-True ($beforeFailure -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($envPath))) "failed replacement changed .env"
        Assert-True (($failedReplace.Stdout + $failedReplace.Stderr) -notmatch '[0-9a-f]{64}') "failed replacement printed token-shaped output"
        Assert-Equal 0 @(Get-ChildItem -LiteralPath $tempRoot -Force -Filter '.env.wf-admin-token.*.tmp').Count "failed replacement left a temporary file"
    } finally {
        [IO.File]::SetAttributes($envPath, [IO.FileAttributes]::Normal)
    }

    Write-Output "PASS generate-admin-token"
} finally {
    if (Test-Path -LiteralPath $tempRoot) {
        $resolved = [IO.Path]::GetFullPath($tempRoot)
        if (-not $resolved.StartsWith($tempBase + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not (Split-Path -Leaf $resolved).StartsWith("wf-admin-token-tests-")) {
            throw "refusing unsafe test cleanup: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
