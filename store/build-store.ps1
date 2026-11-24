# Build the Microsoft Store (MSIX) package for HyperVoice Code.
#
#   powershell -ExecutionPolicy Bypass -File store\build-store.ps1            # build app + pack .msix
#   powershell -ExecutionPolicy Bypass -File store\build-store.ps1 -Register  # also install the layout locally (Developer Mode)
#   ... -SkipBuild                                                            # reuse the last release exe
#
# One binary serves both routes; packaging.rs detects the Store package and
# turns the self-updater off. The .msix is UNSIGNED on purpose: the Store signs
# it on submission. -Register installs the loose layout instead, which
# Developer Mode allows without a certificate.
param(
    [switch]$Register,
    [switch]$SkipBuild,
    [string]$Out = "C:\tmp\hvcode-msix"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "src-tauri"

$conf = Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json
$version = "$($conf.version).0"   # the Store requires x.y.z.0

if (-not $SkipBuild) {
    Push-Location $root
    try {
        # --no-bundle: just the exe (no NSIS, no updater signing needed).
        npx tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

$exeName = "hypervoice-code.exe"
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $tauri "target" }
$exe = Join-Path $targetDir "release\$exeName"
if (-not (Test-Path $exe)) { throw "No release build at $exe" }

$layout = Join-Path $Out "layout"
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Force (Join-Path $layout "Assets") | Out-Null
Copy-Item $exe $layout
Copy-Item (Join-Path $PSScriptRoot "Assets\*.png") (Join-Path $layout "Assets")

$manifest = (Get-Content (Join-Path $PSScriptRoot "AppxManifest.template.xml") -Raw).Replace("{{VERSION}}", $version).Replace("{{EXE}}", $exeName)
[IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifest, (New-Object Text.UTF8Encoding($false)))

$sdk = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { throw "makeappx.exe not found - install the Windows 10/11 SDK" }
$makeappx = Join-Path $sdk.FullName "x64\makeappx.exe"

$msix = Join-Path $Out "HyperVoiceCode_$($conf.version)_x64.msix"
& $makeappx pack /d $layout /p $msix /o | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Write-Host "MSIX: $msix (version $version)"

if ($Register) {
    Get-AppxPackage -Name "ChrisCousens.HyperVoiceCode" | Remove-AppxPackage -ErrorAction SilentlyContinue
    Add-AppxPackage -Register (Join-Path $layout "AppxManifest.xml")
    Write-Host "Registered the loose layout. Start menu: HyperVoice Code (Store build)."
}
