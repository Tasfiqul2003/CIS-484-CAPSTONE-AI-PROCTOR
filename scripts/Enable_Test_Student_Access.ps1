param(
    [string]$Repo = (Join-Path $env:USERPROFILE 'OneDrive\Desktop\Repos\CIS-484-CAPSTONE-AI-PROCTOR'),
    [string]$Package,
    [string]$StudentEid,
    [ValidateRange(1, 24)][int]$Hours = 2,
    [switch]$Disable,
    [switch]$Apply,
    [switch]$MaintenanceWindow,
    [int]$ExpectedOpenSessions = -1
)
$ErrorActionPreference = 'Stop'
if ($MaintenanceWindow -and $ExpectedOpenSessions -lt 0) {
    throw 'Provide -ExpectedOpenSessions for the maintenance window.'
}
if (-not $Disable) {
    if (-not $StudentEid) { $StudentEid = Read-Host 'Enter the test student EID to allow temporarily' }
    $StudentEid = $StudentEid.Trim().ToLowerInvariant()
    if ($StudentEid -notmatch '^[a-zA-Z0-9._-]{1,64}$') { throw 'Enter exactly one valid test student EID.' }
} elseif ($StudentEid) { throw 'Do not combine -Disable with -StudentEid.' }
if (-not $Package) {
    $deliveryRoot = $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'activate_recording_storage.py')) {
        $deliveryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $Package = Join-Path $deliveryRoot 'temporary-photo-test-update'
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
if ($LASTEXITCODE -ne 0) { throw 'The guarded source/Git step stopped. No runtime setting was applied.' }
$controller = Join-Path $Package 'files\scripts\activate_recording_storage.py'
if ($Apply) { $controller = Join-Path $Repo 'scripts\activate_recording_storage.py' }
$controllerArgs = @($controller, '--repo', $Repo)
if ($Disable) {
    $controllerArgs += '--disable-photo-test'
} else {
    $until = [DateTimeOffset]::UtcNow.AddHours($Hours).ToString('o')
    $controllerArgs += @('--photo-test-eid', $StudentEid, '--photo-test-until', $until)
}
if ($Apply) { $controllerArgs += '--apply' }
if ($MaintenanceWindow) { $controllerArgs += @('--maintenance-window', '--expected-open-sessions', [string]$ExpectedOpenSessions) }
& python @controllerArgs
if ($LASTEXITCODE -ne 0) { throw 'Temporary test access stopped. Review the reported status and private recovery folder.' }
