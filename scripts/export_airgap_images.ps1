param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI is required on the connected build machine."
}

if (Test-Path $outputPath) {
    if ((Get-ChildItem -LiteralPath $outputPath -Force | Measure-Object).Count -gt 0) {
        throw "Output directory must be empty: $outputPath"
    }
}

Push-Location $repositoryRoot
try {
    & docker info --format "{{.ServerVersion}}" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Engine is unavailable."
    }

    & docker build --pull -t oralexam-backend:airgap -f backend\Dockerfile backend
    if ($LASTEXITCODE -ne 0) {
        throw "Backend image build failed."
    }

    & docker build --pull -t oralexam-frontend:airgap -f frontend\dockerfile frontend
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend image build failed."
    }

    & docker pull ollama/ollama:latest
    if ($LASTEXITCODE -ne 0) {
        throw "Ollama image pull failed."
    }

    if (-not (Test-Path $outputPath)) {
        New-Item -ItemType Directory -Path $outputPath | Out-Null
    }

    $migrationPath = Join-Path $outputPath "database\migrations"
    $docsPath = Join-Path $outputPath "docs"
    New-Item -ItemType Directory -Path $migrationPath -Force | Out-Null
    New-Item -ItemType Directory -Path $docsPath -Force | Out-Null

    $imageArchive = Join-Path $outputPath "images.tar"
    & docker save -o $imageArchive oralexam-backend:airgap oralexam-frontend:airgap ollama/ollama:latest
    if ($LASTEXITCODE -ne 0) {
        throw "Docker image export failed."
    }

    $archiveHash = (Get-FileHash -LiteralPath $imageArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath (Join-Path $outputPath "images.tar.sha256") -Value "$archiveHash  images.tar" -Encoding ASCII

    Copy-Item docker-compose.airgap.yml $outputPath
    Copy-Item .env.example (Join-Path $outputPath "env.example")
    Copy-Item docs\airgap-deployment.md $docsPath
    Copy-Item database\migrations\013_student_photo_verification.sql $migrationPath
    Copy-Item database\migrations\014_exam_video_recordings.sql $migrationPath
    Copy-Item database\migrations\015_block_face_check_overrides.sql $migrationPath

    Write-Output "Air-gap update bundle created at: $outputPath"
    Write-Output "Do not copy a live .env file into the bundle."
} finally {
    Pop-Location
}
