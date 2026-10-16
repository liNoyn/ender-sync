param(
    [string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$ApiBaseUrl,
    [string]$ApiToken = "replace-me",
    [string]$ServerId = "server-a",
    [string]$WorldId = "world_a",
    [string]$WorldName = "World A"
)

$ErrorActionPreference = "Stop"
if (-not $WorkspaceRoot) { $WorkspaceRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path }
$utf8 = New-Object System.Text.UTF8Encoding $false

$packRoot = Join-Path $WorkspaceRoot "behavior_packs\endersync_bp"
$distRoot = Join-Path $packRoot "dist"
if (-not (Test-Path $distRoot)) { throw "dist not found: $distRoot. Run 'npm run build' in the pack first." }

$manifest = Get-Content -Raw (Join-Path $packRoot "manifest.json") | ConvertFrom-Json
$moduleUuid = ($manifest.modules | Where-Object { $_.type -eq "script" } | Select-Object -First 1).uuid

$bundleRoot = Join-Path $WorkspaceRoot "bds_ready\endersync_bundle"
$bundlePack = Join-Path $bundleRoot "behavior_packs\endersync_bp"
$bundleScripts = Join-Path $bundlePack "scripts"
$bundleConfig = Join-Path $bundleRoot "config\$moduleUuid"

if (Test-Path $bundleRoot) { Remove-Item -LiteralPath $bundleRoot -Recurse -Force }
New-Item -ItemType Directory -Force $bundleScripts, $bundleConfig | Out-Null
Copy-Item -Path (Join-Path $distRoot "*") -Destination $bundleScripts -Recurse -Force

# Runtime manifest: the compiled entrypoint lives at scripts/main.js.
$manifestJson = (Get-Content -Raw (Join-Path $packRoot "manifest.json")).Replace('dist/main.js', 'scripts/main.js')
[IO.File]::WriteAllText((Join-Path $bundlePack "manifest.json"), $manifestJson, $utf8)

# Bake the connection settings into the compiled config. The token ends up inside the pack, so do not share the bundle.
$configPath = Join-Path $bundleScripts "util\config.js"
$js = [IO.File]::ReadAllText($configPath)
$base = $ApiBaseUrl.TrimEnd("/")
$js = $js.Replace('"https://your-endersync-api.example.com"', '"' + $base + '"').Replace('apiToken: "replace-me"', 'apiToken: "' + $ApiToken + '"')
$js = $js.Replace('serverId: "server-a"', 'serverId: "' + $ServerId + '"').Replace('worldId: "world_a"', 'worldId: "' + $WorldId + '"').Replace('worldName: "World A"', 'worldName: "' + $WorldName + '"')
[IO.File]::WriteAllText($configPath, $js, $utf8)

$forceHttps = if ($base.ToLowerInvariant().StartsWith("https://")) { "true" } else { "false" }
$permissions = @"
{
  "allowed_modules": [
    "@minecraft/server",
    "@minecraft/server-net"
  ],
  "module_permissions": {
    "@minecraft/server-net": {
      "allowed_uris": [
        "$base/"
      ],
      "force_https": $forceHttps,
      "max_body_bytes": 1048576,
      "max_concurrent_requests": 1
    }
  }
}
"@
[IO.File]::WriteAllText((Join-Path $bundleConfig "permissions.json"), $permissions, $utf8)

$zipPath = Join-Path $WorkspaceRoot "bds_ready\endersync_bds_bundle.zip"
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
# Entry names must use "/" so the archive also extracts correctly on Linux.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem -LiteralPath $bundleRoot -Recurse -File) {
        $entryName = $file.FullName.Substring($bundleRoot.Length + 1).Replace("\", "/")
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName)
    }
} finally {
    $zip.Dispose()
}

Write-Output "Bundle: $bundleRoot"
Write-Output "Zip:    $zipPath"