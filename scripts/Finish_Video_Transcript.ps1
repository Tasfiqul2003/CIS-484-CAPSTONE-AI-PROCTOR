param(
    [string]$Repo = (Join-Path $env:USERPROFILE 'OneDrive\Desktop\Repos\CIS-484-CAPSTONE-AI-PROCTOR'),
    [string]$Package,
    [switch]$Apply,
    [switch]$SkipRuntime,
    [switch]$NoStartWorker
)

$ErrorActionPreference = 'Stop'
if (-not $Package) {
    $deliveryRoot = $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'apply_video_update.py')) {
        $deliveryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $Package = Join-Path $deliveryRoot 'video-transcript-update'
}
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$Package = (Resolve-Path -LiteralPath $Package).Path
$installer = Join-Path $Package 'apply_update.py'
$manifestFile = Join-Path $Package 'manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -cne $manifest.installer_sha256.ToUpperInvariant()) {
    throw 'The source installer checksum differs from the reviewed package.'
}
$arguments = @($installer, '--repo', $Repo, '--package', $Package)
if ($Apply) { $arguments += @('--apply', '--commit') }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw 'The guarded source/Git step stopped. Inspect the output; existing recovery files were retained.' }
if (-not $Apply -or $SkipRuntime) { return }

Write-Host 'The reviewed source is committed. Checking the small local speech worker next.'
& (Join-Path $Repo 'scripts\Setup_Speech_Model.ps1') -Repo $Repo -Apply -NoStartWorker:$NoStartWorker

# Inspect only the mount metadata. A base-Compose recreation could discard
# this laptop's other runtime options, so it is never performed blindly.
$priorPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $mountText = & docker inspect --format '{{json .Mounts}}' cis-484-capstone-ai-proctor-backend-1
    $inspectExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $priorPreference }
if ($inspectExit -eq 0) {
    $mounts = ($mountText -join "`n") | ConvertFrom-Json
    $recordingMounts = @($mounts | Where-Object { $_.Destination -eq '/var/lib/oral-exam/recordings' -and $_.RW })
    if ($recordingMounts.Count -eq 1) {
        Write-Host 'The backend has a writable persistent recording mount.'
    } else {
        Write-Host 'The existing backend still needs its persistent recording mount activated before browser recording can work.'
    }
}
Write-Host 'Source and Git handoff complete. A retention date and live synthetic exam verification remain.'
Write-Host 'DB, Ollama, avatar services, Git upstreams and remote branches were not changed.'
