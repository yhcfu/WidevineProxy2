param(
    [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Join-Path $root ".."
$manifestPath = Join-Path $projectRoot "native-host/Cargo.toml"
$binaryName = "widevineproxy2-host.exe"
$destDir = Join-Path $projectRoot "native-host/bin/windows"
$sourcePath = Join-Path $projectRoot "native-host/target/$Target/release/$binaryName"

Write-Host "[info] Windows ネイティブホストをビルドします (target=$Target)..."
cargo build --release --target $Target --manifest-path $manifestPath

if (-not (Test-Path $sourcePath)) {
    throw "ビルド成果物が見つかりません: $sourcePath"
}

New-Item -ItemType Directory -Path $destDir -Force | Out-Null
Copy-Item -Path $sourcePath -Destination (Join-Path $destDir $binaryName) -Force

Write-Host "[done] コピー完了 -> $destDir/$binaryName" 
Write-Host "ZIP 化時はこのファイルを含めて配布してください。"
