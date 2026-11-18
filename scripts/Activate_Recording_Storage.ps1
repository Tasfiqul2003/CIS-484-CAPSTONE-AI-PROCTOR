param(
    [string]$Repo = (Join-Path $env:USERPROFILE 'OneDrive\Desktop\Repos\CIS-484-CAPSTONE-AI-PROCTOR'),
    [string]$Package,
    [string]$BackupDir = (Join-Path $env:USERPROFILE 'CYBROS-backups'),
    [string]$RetentionUntil,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
if (-not $Package) {
    $deliveryRoot = $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'activate_recording_storage.py')) {
        $deliveryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $Package = Join-Path $deliveryRoot 'recording-storage-update'
}
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$Package = (Resolve-Path -LiteralPath $Package).Path
$installer = Join-Path $Package 'apply_update.py'
$manifest = Get-Content -Raw -LiteralPath (Join-Path $Package 'manifest.json') | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -cne $manifest.installer_sha256.ToUpperInvariant()) {
    throw 'The source installer differs from the reviewed package.'
}
$installArgs = @($installer, '--repo', $Repo, '--package', $Package)
if ($Apply) { $installArgs += @('--apply', '--commit') }
& python @installArgs
if ($LASTEXITCODE -ne 0) { throw 'The guarded source/Git step stopped. No storage activation was attempted.' }

$controller = Join-Path $Package 'files\scripts\activate_recording_storage.py'
if ($Apply) { $controller = Join-Path $Repo 'scripts\activate_recording_storage.py' }
$controllerArgs = @($controller, '--repo', $Repo, '--backup-dir', $BackupDir)
if ($RetentionUntil) { $controllerArgs += @('--retention-until', $RetentionUntil) }
if ($Apply) { $controllerArgs += '--apply' }
& python @controllerArgs
if ($LASTEXITCODE -ne 0) { throw 'Recording storage activation stopped. Review the status above and any reported private recovery folder.' }
