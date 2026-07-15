[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Rotate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0


function Set-RestrictedFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($currentSid)
    foreach ($sid in @($currentSid, $systemSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security

    $applied = Get-Acl -LiteralPath $Path
    if (-not $applied.AreAccessRulesProtected) {
        throw "Failed to protect generated .env ACL"
    }
    $expected = @($currentSid.Value, $systemSid.Value) | Sort-Object -Unique
    $actualRules = @($applied.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    ))
    $actual = @($actualRules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)
    if (($expected -join ',') -ne ($actual -join ',')) {
        throw "Generated .env ACL contains unexpected identities"
    }
    foreach ($rule in $actualRules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
                [Security.AccessControl.FileSystemRights]::FullControl) {
            throw "Generated .env ACL is not restricted FullControl"
        }
    }
}


if (-not ([System.Management.Automation.PSTypeName]"WfAtomicFile").Type) {
    Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;

public static class WfAtomicFile
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool MoveFileEx(
        string existingFileName,
        string newFileName,
        int flags
    );
}
"@
}

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$envPath = Join-Path $repoRoot ".env"
$examplePath = Join-Path $repoRoot ".env.example"
if (Test-Path -LiteralPath $envPath -PathType Container) {
    throw ".env is a directory, refusing to replace it"
}

$envExists = Test-Path -LiteralPath $envPath -PathType Leaf
if ($envExists) {
    $content = [IO.File]::ReadAllText($envPath)
} elseif (Test-Path -LiteralPath $examplePath -PathType Leaf) {
    $content = [IO.File]::ReadAllText($examplePath)
} else {
    $content = ""
}

$tokenLine = New-Object Text.RegularExpressions.Regex(
    '(?m)^[ \t]*(?:export[ \t]+)?CN_ADMIN_TOKEN[ \t]*=.*\r?$'
)
$matches = $tokenLine.Matches($content)
if ($matches.Count -gt 1) {
    throw ".env contains multiple CN_ADMIN_TOKEN entries"
}
if ($matches.Count -eq 1 -and -not $Rotate) {
    throw "CN_ADMIN_TOKEN already exists; use -Rotate to replace it"
}

$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$sha = [Security.Cryptography.SHA256]::Create()
$tempPath = $null
$token = $null
try {
    $randomBytes = New-Object byte[] 32
    $rng.GetBytes($randomBytes)
    $token = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
    $fingerprint = (-join ($digest | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
    $replacement = 'CN_ADMIN_TOKEN="' + $token + '"'

    if ($matches.Count -eq 1) {
        $newContent = $tokenLine.Replace($content, $replacement, 1)
    } else {
        $newline = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
        if ($content.Length -gt 0 -and -not ($content.EndsWith("`n") -or $content.EndsWith("`r"))) {
            $content += $newline
        }
        $newContent = $content + $replacement + $newline
    }

    Write-Output "Target: $envPath"
    if ($WhatIfPreference) {
        Write-Output "WhatIf: CN_ADMIN_TOKEN fingerprint=$fingerprint"
        return
    }

    $tempPath = Join-Path $repoRoot (
        ".env.wf-admin-token.{0}.{1}.tmp" -f $PID, [Guid]::NewGuid().ToString("N")
    )
    $utf8 = New-Object Text.UTF8Encoding($false)
    $encoded = $utf8.GetBytes($newContent)
    $stream = New-Object IO.FileStream(
        $tempPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )
    try {
        $stream.Write($encoded, 0, $encoded.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }

    Set-RestrictedFileAcl -Path $tempPath

    $moveFileReplaceExisting = 0x1
    $moveFileWriteThrough = 0x8
    $moved = [WfAtomicFile]::MoveFileEx(
        $tempPath,
        $envPath,
        $moveFileReplaceExisting -bor $moveFileWriteThrough
    )
    if (-not $moved) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw (New-Object ComponentModel.Win32Exception($code, "Atomic .env replacement failed"))
    }
    $tempPath = $null
    Write-Output "Configured CN_ADMIN_TOKEN; fingerprint=$fingerprint"
} finally {
    $token = $null
    $rng.Dispose()
    $sha.Dispose()
    if ($tempPath -and (Test-Path -LiteralPath $tempPath)) {
        Remove-Item -LiteralPath $tempPath -Force
    }
}
