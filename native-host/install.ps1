param(
    [string]$ExtensionId,
    [string]$ManifestName = "com.widevineproxy2.downloader.json",
    [string]$TargetRoot = "$env:LOCALAPPDATA\WidevineProxy2",
    [switch]$ConfigurePolicies = $true,
    [string]$ExpectedSha256,
    [string]$ExpectedThumbprint,
    [switch]$ManifestOnly,
    [string]$BinaryPath
)

$ErrorActionPreference = "Stop"

<#
.SYNOPSIS
進捗メッセージをログに整形して出力します。
#>
function Write-Info($Message) {
    Write-Host "[info] $Message"
}

<#
.SYNOPSIS
ネイティブメッセージングポリシーに値を追加します。
.DESCRIPTION
同じ値が既にあれば再登録を避け、空きスロットへ追記します。
#>
function Add-PolicyEntry {
    param(
        [string]$KeyPath,
        [string]$Value
    )
    New-Item -Path $KeyPath -Force | Out-Null
    $item = Get-Item -Path $KeyPath -ErrorAction SilentlyContinue
    if ($item) {
        foreach ($name in $item.Property) {
            $current = Get-ItemPropertyValue -Path $KeyPath -Name $name -ErrorAction SilentlyContinue
            if ($current -eq $Value) {
                return
            }
        }
    }
    $index = 1
    while ($true) {
        $slot = $index.ToString()
        $current = Get-ItemPropertyValue -Path $KeyPath -Name $slot -ErrorAction SilentlyContinue
        if (-not $current) {
            Set-ItemProperty -Path $KeyPath -Name $slot -Value $Value
            return
        }
        $index++
    }
}

<#
.SYNOPSIS
Chrome の推奨ポリシー (Allowlist/Blocklist) を設定します。
#>
function Ensure-NativeMessagingPolicies {
    param(
        [string]$HostName
    )
    $policyRoot = "HKCU:\Software\Policies\Google\Chrome"
    New-Item -Path $policyRoot -Force | Out-Null
    $blocklistKey = Join-Path $policyRoot "NativeMessagingBlocklist"
    Add-PolicyEntry -KeyPath $blocklistKey -Value "*"
    $allowlistKey = Join-Path $policyRoot "NativeMessagingAllowlist"
    Add-PolicyEntry -KeyPath $allowlistKey -Value $HostName
    Write-Info "CIS 推奨ポリシーを適用しました (allowlist: $HostName)"
}

<#
.SYNOPSIS
バイナリ署名およびハッシュを検証します。
#>
function Test-BinaryIntegrity {
    param(
        [string]$FilePath,
        [string]$ExpectedSha256,
        [string]$ExpectedThumbprint
    )
    if ($ExpectedSha256) {
        $hash = (Get-FileHash -Path $FilePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($hash -ne $ExpectedSha256.ToLowerInvariant()) {
            throw "${FilePath} の SHA256 が一致しません: $hash"
        }
        Write-Info "SHA256 が期待値と一致しました。"
    }
    if ($ExpectedThumbprint) {
        $signature = Get-AuthenticodeSignature -FilePath $FilePath
        if ($signature.Status -ne 'Valid') {
            throw "${FilePath} のコード署名が無効です: $($signature.Status)"
        }
        if ($signature.SignerCertificate.Thumbprint -ne $ExpectedThumbprint) {
            throw "コード署名のサムプリントが一致しません。期待: $ExpectedThumbprint"
        }
        Write-Info "コード署名のサムプリントが一致しました。"
    }
}

<#
.SYNOPSIS
chrome://extensions から取得した拡張機能 ID を確定します。
.DESCRIPTION
パラメータ未指定時は対話的に入力を促し、空であればエラーにします。
#>
function Resolve-ExtensionId {
    param(
        [string]$Value
    )

    if ($Value) {
        return $Value.Trim()
    }

    Write-Host ""
    Write-Info "chrome://extensions で表示される拡張機能 ID を入力してください。"
    $input = Read-Host "Extension ID"
    if (-not $input) {
        throw "ExtensionId が入力されていないため続行できません。"
    }
    return $input.Trim()
}

$ExtensionId = Resolve-ExtensionId -Value $ExtensionId

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$binarySource = $BinaryPath
if (-not $binarySource) {
    $binarySource = Join-Path $scriptDir "widevineproxy2-host.exe"
}
$binaryExists = Test-Path $binarySource

if (-not $binaryExists -and -not $ManifestOnly) {
    throw "widevineproxy2-host.exe が見つかりません: $binarySource"
}

if (-not $ManifestOnly -and $binaryExists) {
    Test-BinaryIntegrity -FilePath $binarySource -ExpectedSha256 $ExpectedSha256 -ExpectedThumbprint $ExpectedThumbprint
}

$manifestTemplate = Join-Path $scriptDir $ManifestName
if (-not (Test-Path $manifestTemplate)) {
    throw "マニフェストテンプレートが見つかりません: $manifestTemplate"
}

$nativeDir = Join-Path $TargetRoot "NativeMessaging"
New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null

$manifestTarget = Join-Path $nativeDir $ManifestName
$manifestContent = Get-Content -Path $manifestTemplate -Raw
$binaryDest = Join-Path $TargetRoot "widevineproxy2-host.exe"
$escapedBinary = $binaryDest.Replace('\\', '\\\\')
$manifestContent = $manifestContent.Replace("__HOST_BINARY__", $escapedBinary)
$manifestContent = $manifestContent.Replace("__EXTENSION_ID__", $ExtensionId)

$manifestContent | Set-Content -Path $manifestTarget -Encoding UTF8

# ManifestOnly の場合は manifest の更新だけで完了させる。
if (-not $ManifestOnly) {
    Copy-Item -Path $binarySource -Destination $binaryDest -Force
    icacls $binaryDest /grant:r "$env:USERNAME:(RX)" | Out-Null
    Write-Info "マニフェストを $manifestTarget に配置しました。"
    Write-Info "バイナリを $binaryDest に配置しました。"
} else {
    if (-not (Test-Path $binaryDest)) {
        Write-Warning "ManifestOnly オプションが指定されていますが $binaryDest が見つかりません。先に通常モードでインストールしてください。"
    } else {
        Write-Info "ManifestOnly モードでバイナリコピーをスキップしました。"
        Write-Info "マニフェストを $manifestTarget に再生成しました。"
    }
}

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.widevineproxy2.downloader"
New-Item -Path $registryPath -Force | Out-Null
Set-ItemProperty -Path $registryPath -Name '(default)' -Value $manifestTarget
Write-Info "レジストリ $registryPath を更新しました。"

$legacyKey = "HKLM:\Software\Google\Chrome\NativeMessagingHosts\com.widevineproxy2.downloader"
if (Test-Path $legacyKey) {
    Write-Warning "システムスコープ(HKLM)に旧マニフェストが残っています。削除してからユーザースコープ版を利用してください: $legacyKey"
}

$legacyDir = "C:\Program Files\WidevineProxy2"
if (Test-Path $legacyDir) {
    Write-Warning "旧インストーラの残骸が検出されました: $legacyDir (必要に応じて手動削除してください)"
}

$requiredBins = @("yt-dlp", "mp4decrypt", "ffmpeg")
$missingBins = @()
foreach ($bin in $requiredBins) {
    if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
        $missingBins += $bin
    }
}

if ($missingBins.Count -gt 0) {
    Write-Warning "以下のコマンドが見つかりませんでした: $($missingBins -join ', ')"
    Write-Warning "必要なバイナリをPATHに追加するか、設定でパスを指定してください。"
} else {
    Write-Info "必要な外部バイナリを検出しました。"
}

if ($ConfigurePolicies) {
    Ensure-NativeMessagingPolicies -HostName "com.widevineproxy2.downloader"
}

Write-Info "インストールが完了しました。Chrome/Edge で chrome://extensions/ にアクセスし、拡張機能を再読み込みしてから『Service Worker』のコンソールで 'Native host: connected' が表示されるか確認してください。"
