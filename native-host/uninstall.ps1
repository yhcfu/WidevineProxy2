param(
    [string]$ManifestName = "com.widevineproxy2.downloader.json",
    [string]$TargetRoot = "$env:LOCALAPPDATA\WidevineProxy2",
    [switch]$CleanupPolicies = $true
)

$ErrorActionPreference = "Stop"

function Write-Info($Message) {
    Write-Host "[info] $Message"
}

function Remove-PolicyEntry {
    param(
        [string]$KeyPath,
        [string]$Value
    )
    if (-not (Test-Path $KeyPath)) {
        return
    }
    $item = Get-Item -Path $KeyPath -ErrorAction SilentlyContinue
    if (-not $item) {
        return
    }
    foreach ($name in $item.Property) {
        $current = Get-ItemPropertyValue -Path $KeyPath -Name $name -ErrorAction SilentlyContinue
        if ($current -eq $Value) {
            Remove-ItemProperty -Path $KeyPath -Name $name -ErrorAction SilentlyContinue
        }
    }
    $updated = Get-Item -Path $KeyPath -ErrorAction SilentlyContinue
    if (-not $updated -or -not $updated.Property -or $updated.Property.Count -eq 0) {
        Remove-Item -Path $KeyPath -Force
    }
}

function Cleanup-NativeMessagingPolicies {
    param(
        [string]$HostName
    )
    $policyRoot = "HKCU:\Software\Policies\Google\Chrome"
    $allowlistKey = Join-Path $policyRoot "NativeMessagingAllowlist"
    Remove-PolicyEntry -KeyPath $allowlistKey -Value $HostName
    $remainingAllow = Get-Item -Path $allowlistKey -ErrorAction SilentlyContinue
    if (-not $remainingAllow) {
        $blocklistKey = Join-Path $policyRoot "NativeMessagingBlocklist"
        Remove-PolicyEntry -KeyPath $blocklistKey -Value "*"
    }
}

$nativeDir = Join-Path $TargetRoot "NativeMessaging"
$manifestTarget = Join-Path $nativeDir $ManifestName
$binaryPath = Join-Path $TargetRoot "widevineproxy2-host.exe"

if (Test-Path $manifestTarget) {
    Remove-Item -Path $manifestTarget -Force
    Write-Info "マニフェストを削除しました: $manifestTarget"
}

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.widevineproxy2.downloader"
if (Test-Path $registryPath) {
    Remove-Item -Path $registryPath -Recurse -Force
    Write-Info "レジストリキーを削除しました: $registryPath"
}

if (Test-Path $nativeDir -and -not (Get-ChildItem -Path $nativeDir)) {
    Remove-Item -Path $nativeDir -Force
}

if (Test-Path $binaryPath) {
    Remove-Item -Path $binaryPath -Force
    Write-Info "バイナリを削除しました: $binaryPath"
}

if ($CleanupPolicies) {
    Cleanup-NativeMessagingPolicies -HostName "com.widevineproxy2.downloader"
    Write-Info "ネイティブメッセージング関連のポリシーをクリーンアップしました。"
}

Write-Info "アンインストールが完了しました。"
