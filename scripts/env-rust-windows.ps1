# ASCII-path Rust env for Windows (fixes mingw ld + non-ASCII username)
# Usage: . .\scripts\env-rust-windows.ps1

$ErrorActionPreference = 'Stop'

$asciiRustup = 'C:\Rust\rustup'
$asciiCargoBin = 'C:\Rust\cargo\bin'
$userRustup = Join-Path $env:USERPROFILE '.rustup'
$userCargo = Join-Path $env:USERPROFILE '.cargo'
$toolchain = 'stable-x86_64-pc-windows-gnu'
$srcToolchain = Join-Path $userRustup "toolchains\$toolchain"
$dstToolchain = Join-Path $asciiRustup "toolchains\$toolchain"

if (-not (Test-Path (Join-Path $dstToolchain 'bin\rustc.exe'))) {
  if (-not (Test-Path (Join-Path $srcToolchain 'bin\rustc.exe'))) {
    throw "Missing $toolchain under $userRustup. Install: rustup toolchain install $toolchain"
  }
  Write-Host "Seeding ASCII rustup at $asciiRustup from $srcToolchain ..."
  New-Item -ItemType Directory -Force -Path (Join-Path $asciiRustup 'toolchains') | Out-Null
  robocopy $srcToolchain $dstToolchain /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
}

@"
default_toolchain = "$toolchain"
profile = "minimal"
version = "12"

[overrides]
"@ | Set-Content (Join-Path $asciiRustup 'settings.toml') -Encoding ASCII

$env:RUSTUP_HOME = $asciiRustup
# Keep crate cache in the original CARGO_HOME (network/offline friendly)
$env:CARGO_HOME = $userCargo
$env:Path = "$asciiCargoBin;$dstToolchain\bin;$env:Path"

if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
  Write-Warning "wasm-pack not on PATH. Install binary into $asciiCargoBin or ~/.cargo/bin"
}

Write-Host "RUSTUP_HOME=$env:RUSTUP_HOME"
Write-Host "sysroot=$(rustc --print sysroot)"
