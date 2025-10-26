﻿param(
    [string]$ExtensionId,
    [switch]$ManifestOnly,
    [string]$BinaryPath,
    [string]$TargetRoot,
    [string]$ManifestName,
    [string]$ExpectedSha256,
    [string]$ExpectedThumbprint,
    [switch]$DisablePolicies
)

$ErrorActionPreference = "Stop"
$GuideUrl = "https://github.com/yhcfu/WidevineProxy2/blob/main/docs/getting-started/install-windows.md"

<#
.SYNOPSIS
    リポジトリルートから Windows ネイティブホストをセットアップします。

.DESCRIPTION
    リポジトリを ZIP 展開した直後に実行できるよう、`native-host/bin/windows/` 配下の事前ビルド済みバイナリを探して `native-host/install.ps1` へ引き渡します。
    Extension ID を指定しない場合は、下位スクリプトが chrome://extensions で確認した ID の入力を促します。

.NOTES
    PowerShell のコメントベースヘルプ構文で記述し、`.SYNOPSIS` がコマンドとして解釈されないようにしています。
#>
function Invoke-NativeHostInstall {
    param(
        [string]$ExtensionId,
        [switch]$ManifestOnly,
        [string]$BinaryPath,
        [string]$TargetRoot,
        [string]$ManifestName,
        [string]$ExpectedSha256,
        [string]$ExpectedThumbprint,
        [switch]$DisablePolicies
    )

    $root = if ($MyInvocation.MyCommand.Path) {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        Get-Location
    }
    $installScript = Join-Path $root "native-host/install.ps1"
    if (-not (Test-Path $installScript)) {
        $warn = @"
[warn] native-host/install.ps1 が見つかりません: $installScript
[hint] 最新の ZIP をダウンロードするか、$GuideUrl の「ネイティブホストの導入」を確認して不足ファイルを復元してください。
[help] `git clean -fdx; git checkout -- .` でファイルを取り直す方法もあります (未コミット変更は失われます)。
"@
        Write-Warning $warn
        throw "missing dependency: native-host/install.ps1"
    }

    if (-not $BinaryPath) {
        $BinaryPath = Join-Path $root "native-host/bin/windows/widevineproxy2-host.exe"
        if (-not (Test-Path $BinaryPath)) {
            # 後方互換: 旧パス (native-host/bin/) や直下配置を試す
            $fallbacks = @(
                (Join-Path $root "native-host/bin/widevineproxy2-host.exe"),
                (Join-Path $root "native-host/widevineproxy2-host.exe"),
                (Join-Path $root "native-host/target/release/widevineproxy2-host.exe")
            )
            foreach ($candidate in $fallbacks) {
                if (Test-Path $candidate) {
                    $BinaryPath = $candidate
                    break
                }
            }
        }
    }

    if (-not (Test-Path $BinaryPath) -and -not $ManifestOnly) {
        $warn = @"
[warn] 事前ビルド済み Windows バイナリが見つかりませんでした: $BinaryPath
[todo] `scripts/build-native-host.sh windows` を実行して `native-host/bin/windows/` に生成するか、$GuideUrl のリリース手順から ZIP 内の `widevineproxy2-host.exe` をコピーしてください。
[hint] バイナリを配置したら install-windows-native-host.ps1 を再実行してください。
"@
        Write-Warning $warn
        throw "missing dependency: native-host binary"
    }

    $invokeParams = @{ BinaryPath = $BinaryPath }
    if ($PSBoundParameters.ContainsKey('ExtensionId')) { $invokeParams.ExtensionId = $ExtensionId }
    if ($ManifestOnly) { $invokeParams.ManifestOnly = $true }
    if ($PSBoundParameters.ContainsKey('TargetRoot')) { $invokeParams.TargetRoot = $TargetRoot }
    if ($PSBoundParameters.ContainsKey('ManifestName')) { $invokeParams.ManifestName = $ManifestName }
    if ($PSBoundParameters.ContainsKey('ExpectedSha256')) { $invokeParams.ExpectedSha256 = $ExpectedSha256 }
    if ($PSBoundParameters.ContainsKey('ExpectedThumbprint')) { $invokeParams.ExpectedThumbprint = $ExpectedThumbprint }
    if ($DisablePolicies) { $invokeParams.ConfigurePolicies = $false }

    Write-Host "[info] native-host/install.ps1 を呼び出します..."
    & $installScript @invokeParams
}

Invoke-NativeHostInstall @PSBoundParameters
