﻿param(
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
$GuideUrl = "https://github.com/yhcfu/WidevineProxy2/blob/main/docs/getting-started/install-windows.md"

<#
.SYNOPSIS
    進捗メッセージをログに整形して出力します。

.DESCRIPTION
    ログ出力のフォーマットを統一するため、`[info]` プレフィックスを付与してメッセージを表示します。
#>
function Write-Info($Message) {
    Write-Host "[info] $Message"
}

<#
.SYNOPSIS
    Windows 向けのセットアップ手順をまとめて表示します。

.DESCRIPTION
    インストール完了後にユーザーへ次のアクションを提示するため、主要なステップとドキュメント URL を案内します。
#>
function Show-WindowsInstallGuide {
    Write-Host ""
    Write-Host "最終チェック: chrome://extensions/ の Service Worker コンソールで 'Native host: connected' を確認してください。"
    Write-Host "詳細手順: $GuideUrl"
}

<#
.SYNOPSIS
    必要な外部コマンドの導入手順を案内します。

.DESCRIPTION
    yt-dlp / ffmpeg / mp4decrypt が PATH から見付からない場合に、パッケージマネージャーと手動インストールの代表的な流れを表示します。
#>
function Show-MissingBinaryInstructions {
    param(
        [string[]]$Names
    )

    Write-Host ""
    Write-Warning "不足している外部コマンドの導入ガイドを表示します。"
    if ($Names -contains "yt-dlp") {
        Write-Host "[yt-dlp]"
        Write-Host " winget 経由:   winget install yt-dlp"
        Write-Host " Chocolatey:    choco install yt-dlp"
        Write-Host " 手動:          https://github.com/yt-dlp/yt-dlp/releases から yt-dlp.exe を取得し、PATH 上のディレクトリに配置します。"
        Write-Host " 更新:          yt-dlp -U または winget upgrade yt-dlp"
    }
    if ($Names -contains "ffmpeg") {
        Write-Host ""
        Write-Host "[ffmpeg]"
        Write-Host " winget 経由:   winget install --id=Gyan.FFmpeg -e"
        Write-Host " Chocolatey:    choco install ffmpeg"
        Write-Host " 手動:          https://www.gyan.dev/ffmpeg/builds/ から Release Essentials を展開し、bin フォルダを PATH に追加します。"
        Write-Host " 動作確認:      ffmpeg -version"
    }
    if ($Names -contains "mp4decrypt") {
        Write-Host ""
        Write-Host "[mp4decrypt (Bento4)]"
        Write-Host " ダウンロード:  https://www.bento4.com/downloads/ から Windows 用 SDK を取得します。"
        Write-Host " 展開:          bin\\mp4decrypt.exe を任意のフォルダへコピーし、そのフォルダを PATH に追加します。"
        Write-Host " 代替:          vcpkg install bento4 で CLI 一式を導入することもできます。"
        Write-Host " 動作確認:      mp4decrypt --version"
    }
    Write-Host ""
    Write-Host "PATH への追加手順 (共通)"
    Write-Host " - Win + X → 「システム」→「システムの詳細設定」→「環境変数」を開きます。"
    Write-Host " - 「ユーザー環境変数」の PATH を選び「編集」を押して、新しい行にインストール先 (例: C:\\Tools\\yt-dlp、C:\\ffmpeg\\bin) を追加します。"
    Write-Host "   → この操作はユーザー環境変数に永続的に反映され、次回以降のセッションでも利用できます。"
    Write-Host " - 変更後に PowerShell やブラウザを再起動し、where yt-dlp などで検出できるか確認してください。"
}

<#
.SYNOPSIS
    ネイティブメッセージングポリシーに値を追加します。

.DESCRIPTION
    指定値が既存エントリと一致する場合は再登録を回避し、空いているスロットへ連番で書き込みます。
#>
function Add-PolicyEntry {
    param(
        [string]$KeyPath,
        [string]$Value
    )
    New-Item -Path $KeyPath -Force | Out-Null
    $numericPropertyNames = @()
    $existing = Get-ItemProperty -Path $KeyPath -ErrorAction SilentlyContinue
    if ($existing) {
        foreach ($prop in $existing.PSObject.Properties) {
            if ($prop.Name -match '^\d+$') {
                $numericPropertyNames += $prop.Name
                if ($prop.Value -eq $Value) {
                    return
                }
            }
        }
    }
    $index = 1
    while ($numericPropertyNames -contains $index.ToString()) {
        $index++
    }
    $slot = $index.ToString()
    Set-ItemProperty -Path $KeyPath -Name $slot -Value $Value
}

<#
.SYNOPSIS
    Chrome の推奨ポリシー (Allowlist/Blocklist) を設定します。

.DESCRIPTION
    CIS ガイドラインに基づき Blocklist と Allowlist を適切に登録し、ネイティブホストが許可された場合のみ通信できるようにします。
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

.DESCRIPTION
    SHA-256 とコード署名のサムプリントが期待値と一致するか確認し、不整合があれば即座に停止させます。
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
    パラメーター未指定時にはユーザー入力を促し、空文字の場合は例外を投げて後続処理を防ぎます。
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
$binaryDest = Join-Path $TargetRoot "widevineproxy2-host.exe"
$manifestObject = Get-Content -Path $manifestTemplate -Raw | ConvertFrom-Json
$manifestObject.path = $binaryDest
$manifestObject.allowed_origins = @("chrome-extension://{0}/" -f $ExtensionId)
$manifestContent = $manifestObject | ConvertTo-Json -Depth 4
Set-Content -Path $manifestTarget -Encoding UTF8 -Value $manifestContent

# ManifestOnly の場合は manifest の更新だけで完了させる。
if (-not $ManifestOnly) {
    Copy-Item -Path $binarySource -Destination $binaryDest -Force
    $currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    # 現在ユーザーの完全修飾名と環境変数 USERNAME の両方を試し、icacls が無効パラメータ扱いするケースを回避する。
    $grantCandidates = @("${currentIdentity}:(RX)")
    $envGrant = "${env:USERNAME}:(RX)"
    if (-not $grantCandidates.Contains($envGrant)) {
        $grantCandidates += $envGrant
    }
    $icaclsSucceeded = $false
    foreach ($grant in $grantCandidates) {
        & icacls $binaryDest /grant:r $grant 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $icaclsSucceeded = $true
            Write-Info "アクセス権を $grant で付与しました。"
            break
        }
    }
    if (-not $icaclsSucceeded) {
        Write-Warning "icacls によるアクセス権設定に失敗しました。必要に応じて $binaryDest の ACL を手動で調整してください。"
    }
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
    Show-MissingBinaryInstructions -Names $missingBins
} else {
    Write-Info "必要な外部バイナリを検出しました。"
}

if ($ConfigurePolicies) {
    Ensure-NativeMessagingPolicies -HostName "com.widevineproxy2.downloader"
}

Write-Info "インストールが完了しました。Chrome/Edge で chrome://extensions/ にアクセスし、拡張機能を再読み込みしてから『Service Worker』のコンソールで 'Native host: connected' が表示されるか確認してください。"
Show-WindowsInstallGuide
