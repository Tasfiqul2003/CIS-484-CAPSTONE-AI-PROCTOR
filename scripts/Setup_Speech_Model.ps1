param(
    [string]$Repo = (Split-Path -Parent $PSScriptRoot),
    [string]$ModelDir = (Join-Path $env:USERPROFILE 'CYBROS-models\faster-whisper-base.en'),
    [string]$BackupDir = (Join-Path $env:USERPROFILE 'CYBROS-backups'),
    [switch]$Apply,
    [switch]$SkipSyntheticSpeechTest,
    [switch]$NoStartWorker
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path -LiteralPath $Repo).Path
$ModelDir = [IO.Path]::GetFullPath($ModelDir)
if ($ModelDir.TrimEnd('\') -eq $Repo.TrimEnd('\') -or
    $ModelDir.StartsWith($Repo.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Store the speech model outside the Git checkout.'
}
if ($ModelDir.IndexOfAny([char[]]"`r`n`"") -ge 0) { throw 'The model directory contains unsupported characters.' }
$envFile = Join-Path $Repo '.env'
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'The existing private .env file is required.' }
$requirementsFile = Join-Path $Repo 'backend\requirements-transcription.txt'
$requirementsBytes = [IO.File]::ReadAllBytes($requirementsFile)
$requirementsText = [Text.UTF8Encoding]::new($false, $true).GetString($requirementsBytes).Replace("`r`n", "`n").TrimEnd("`n")
$originalRequirements = "-r requirements.txt`nfaster-whisper==1.2.1"
# Faster-Whisper 1.2.1 passes metadata_errors to av.open; PyAV 19 removed it.
$legacyFixedRequirements = $originalRequirements + "`n# PyAV 19 removes metadata_errors used by faster-whisper 1.2.1.`nav==18.1.0"
$fixedRequirements = "# Worker imports the private media helpers; document parsers and OpenCV are not needed.`nfastapi`nsqlalchemy`npsycopg2-binary`npwdlib[argon2]`nPyJWT`nfaster-whisper==1.2.1`n# PyAV 19 removes metadata_errors used by faster-whisper 1.2.1.`nav==18.1.0"
if ($requirementsText -cne $originalRequirements -and $requirementsText -cne $legacyFixedRequirements -and $requirementsText -cne $fixedRequirements) {
    throw 'Speech dependency requirements differ from the reviewed versions. Inspect them before applying this repair.'
}
$composeArguments = @('compose', '-f', 'docker-compose.yml', '-f', 'compose.transcription.yaml')
$backendContainer = 'cis-484-capstone-ai-proctor-backend-1'

function Invoke-DockerText {
    param([string[]]$DockerArguments)
    $priorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & docker @DockerArguments
        $nativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $priorPreference }
    if ($nativeExit -ne 0) { throw 'Docker setup command failed. Existing services and data were not removed.' }
    return ($result -join "`n")
}
function Invoke-DockerChecked {
    param([string[]]$DockerArguments)
    $priorPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & docker @DockerArguments
        $nativeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $priorPreference }
    if ($nativeExit -ne 0) { throw 'Docker setup step failed. Stop here and inspect its output.' }
}
function Set-PrivateSetting {
    param([string]$Content, [string]$Name, [string]$Value)
    if ($Value.IndexOfAny([char[]]"`r`n") -ge 0) { throw 'A private setting contains a newline.' }
    $pattern = '(?m)^[ \t]*(?:export[ \t]+)?' + [Regex]::Escape($Name) + '[ \t]*=[^\r\n]*'
    $settingMatches = [Regex]::Matches($Content, $pattern)
    if ($settingMatches.Count -gt 1) { throw ('Resolve duplicate private settings first: ' + $Name) }
    # Single quotes keep dollar signs in a URL literal. The candidate file is
    # subsequently parsed by Compose and compared to the running connection.
    $quoted = "'" + $Value.Replace("'", "\'") + "'"
    $line = $Name + '=' + $quoted
    if ($settingMatches.Count -eq 1) {
        return [Regex]::Replace($Content, $pattern, $line.Replace('$', '$$'))
    }
    if ($Content -and -not $Content.EndsWith("`n")) { $Content += "`r`n" }
    return $Content + $line + "`r`n"
}
function Get-ComposeLiteral {
    param([string]$Value)
    # Compose config escapes dollars for re-use as a Compose document. Decode
    # its rendering once when comparing with an actual container setting.
    return $Value.Replace('$$', '$')
}

$oldDbVariable = $env:DATABASE_URL
$oldModelVariable = $env:EXAM_TRANSCRIPTION_MODELS_DIR
$oldThreadVariable = $env:EXAM_TRANSCRIPTION_CPU_THREADS
$oldMemoryVariable = $env:EXAM_TRANSCRIPTION_MEMORY_LIMIT
$oldLocation = Get-Location
try {
    Set-Location -LiteralPath $Repo
    $env:EXAM_TRANSCRIPTION_MODELS_DIR = $ModelDir
    $env:EXAM_TRANSCRIPTION_CPU_THREADS = '1'
    $env:EXAM_TRANSCRIPTION_MEMORY_LIMIT = '1g'
    $runtimeUrl = (Invoke-DockerText -DockerArguments @('exec', $backendContainer, 'printenv', 'DATABASE_URL')).Trim()
    if (-not $runtimeUrl) { throw 'The running backend has no database connection.' }
    $targetCode = "import os,json; from sqlalchemy.engine import make_url; u=make_url(os.environ['DATABASE_URL']); print(json.dumps(dict(host=u.host,database=u.database)))"
    $target = (Invoke-DockerText -DockerArguments @('exec', $backendContainer, 'python', '-c', $targetCode)) | ConvertFrom-Json
    if ($target.host -ne 'db' -or $target.database -ne 'examdb') { throw 'The backend is not using the inspected db/examdb target.' }
    $originalConfig = (Invoke-DockerText -DockerArguments ($composeArguments + @('config', '--format', 'json'))) | ConvertFrom-Json
    $configuredUrl = Get-ComposeLiteral -Value $originalConfig.services.'transcription-worker'.environment.DATABASE_URL
    if ($configuredUrl -and $configuredUrl -cne $runtimeUrl) { throw 'Compose points to a different database connection. No configuration was changed.' }
    $labels = (Invoke-DockerText -DockerArguments @('inspect', '--format', '{{json .Config.Labels}}', $backendContainer)) | ConvertFrom-Json
    if ($originalConfig.name -ne $labels.'com.docker.compose.project') { throw 'The Compose project does not match the running backend.' }
    $env:DATABASE_URL = $runtimeUrl
    Write-Host 'Verified the existing backend database and Compose project without displaying credentials.'
    if (-not $Apply) {
        Write-Host 'Read-only check complete. Add -Apply to build, provision the local model, test it, save settings and start only the speech worker.'
        exit 0
    }

    New-Item -ItemType Directory -Path $ModelDir -Force | Out-Null
    $part = Get-Item -LiteralPath $ModelDir
    while ($null -ne $part) {
        if ($part.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The model path contains a link or junction.' }
        $part = $part.Parent
    }
    if ($requirementsText -cne $fixedRequirements) {
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
        $requirementsStamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss_fff') + '_' + [Guid]::NewGuid().ToString('N')
        $requirementsBackup = Join-Path $BackupDir ('kay_before_decoder_requirements_' + $requirementsStamp + '.txt')
        $requirementsTemporary = Join-Path (Split-Path -Parent $requirementsFile) ('.kay-decoder-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        try {
            [IO.File]::WriteAllText($requirementsTemporary, $fixedRequirements + "`n", [Text.UTF8Encoding]::new($false))
            if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($requirementsFile)) -cne [Convert]::ToBase64String($requirementsBytes)) {
                throw 'Speech requirements changed during setup. They were not overwritten.'
            }
            [IO.File]::Replace($requirementsTemporary, $requirementsFile, $requirementsBackup)
        } finally {
            if (Test-Path -LiteralPath $requirementsTemporary -PathType Leaf) { Remove-Item -LiteralPath $requirementsTemporary }
        }
        Write-Host 'Pinned PyAV to 18.1.0 for Faster-Whisper 1.2.1; original dependency file backed up outside Git.'
    } else { Write-Host 'The compatible speech dependency pins are already present.' }
    Invoke-DockerChecked -DockerArguments ($composeArguments + @('build', 'transcription-worker'))

    # Exercise the real codec API before downloading/loading any model. A model
    # load alone cannot detect an incompatible PyAV audio decoder.
    $decoderTestCode = "import io,wave; from importlib.metadata import version; from faster_whisper.audio import decode_audio; assert version('av') == '18.1.0'; assert version('faster-whisper') == '1.2.1'; b=io.BytesIO(); w=wave.open(b,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(3200)); w.close(); b.seek(0); audio=decode_audio(b); assert audio.size == 1600, 'Synthetic audio decoding failed'; print('Synthetic audio decoder passed: faster-whisper 1.2.1 / PyAV 18.1.0')"
    Invoke-DockerChecked -DockerArguments ($composeArguments + @('run', '--rm', '--no-deps',
        'transcription-worker', 'python', '-c', $decoderTestCode))

    $required = @('model.bin', 'config.json', 'tokenizer.json')
    $present = @($required | Where-Object { Test-Path -LiteralPath (Join-Path $ModelDir $_) -PathType Leaf })
    $marker = Join-Path $ModelDir '.cybros_model_source'
    if ($present.Count -ne $required.Count) {
        if ($present.Count -gt 0 -and (-not (Test-Path -LiteralPath $marker) -or
            [IO.File]::ReadAllText($marker).Trim() -ne 'Systran/faster-whisper-base.en')) {
            throw 'A partial unrecognized model already exists. Supply a complete local model or a different empty directory.'
        }
        [IO.File]::WriteAllText($marker, 'Systran/faster-whisper-base.en', [Text.UTF8Encoding]::new($false))
        $downloadCode = "from huggingface_hub import snapshot_download; snapshot_download(repo_id='Systran/faster-whisper-base.en', local_dir='/model-output', allow_patterns=['model.bin','config.json','tokenizer.json','vocabulary.*','preprocessor_config.json'])"
        Invoke-DockerChecked -DockerArguments ($composeArguments + @('run', '--rm', '--no-deps',
            '-e', 'HF_HUB_OFFLINE=0', '-e', 'TRANSFORMERS_OFFLINE=0', '-e', 'HF_HOME=/tmp/huggingface',
            '-e', 'HF_HUB_DISABLE_XET=1', '-v', ($ModelDir + ':/model-output'), '--entrypoint', 'python',
            'transcription-worker', '-c', $downloadCode))
    } else { Write-Host 'Using the existing complete local model directory.' }
    Invoke-DockerChecked -DockerArguments ($composeArguments + @('run', '--rm', '--no-deps',
        'transcription-worker', 'python', '-m', 'app.transcription_worker', '--check'))

    if (-not $SkipSyntheticSpeechTest) {
        $fixtureName = 'cybros_speech_selftest_' + [Guid]::NewGuid().ToString('N') + '.wav'
        $fixturePath = Join-Path $ModelDir $fixtureName
        $fixtureReady = $false
        $speaker = $null
        try {
            Add-Type -AssemblyName System.Speech
            $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
            $speaker.SetOutputToWaveFile($fixturePath)
            $speaker.Speak('Hello. This is a synthetic recording test. The transcript is saved locally.')
            $fixtureReady = $true
        } catch {
            Write-Host 'Windows speech synthesis is unavailable; the local model check passed, but a live speech test remains.'
        } finally { if ($null -ne $speaker) { $speaker.Dispose() } }
        try {
            if ($fixtureReady) {
                $selfTestCode = "from app.transcription_worker import configuration,load_model,transcribe; c=configuration(); f=open('/models/transcription/" + $fixtureName + "','rb'); t=transcribe(f,load_model(c),c); f.close(); assert t.strip(), 'Synthetic speech produced no transcript'; print('Synthetic speech decoder test:'); print(t)"
                Invoke-DockerChecked -DockerArguments ($composeArguments + @('run', '--rm', '--no-deps',
                    'transcription-worker', 'python', '-c', $selfTestCode))
            }
        } finally {
            # This is the exact newly generated synthetic file, never a user recording.
            if (Test-Path -LiteralPath $fixturePath -PathType Leaf) { Remove-Item -LiteralPath $fixturePath }
        }
    }

    # Retain all existing private settings. Never print or commit their values.
    $encoding = [Text.UTF8Encoding]::new($false, $true)
    $originalBytes = [IO.File]::ReadAllBytes($envFile)
    $content = $encoding.GetString($originalBytes)
    $candidate = Set-PrivateSetting -Content $content -Name 'DATABASE_URL' -Value $runtimeUrl
    $candidate = Set-PrivateSetting -Content $candidate -Name 'EXAM_TRANSCRIPTION_MODELS_DIR' -Value $ModelDir.Replace('\', '/')
    $candidate = Set-PrivateSetting -Content $candidate -Name 'EXAM_TRANSCRIPTION_CPU_THREADS' -Value '1'
    $candidate = Set-PrivateSetting -Content $candidate -Name 'EXAM_TRANSCRIPTION_MEMORY_LIMIT' -Value '1g'
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss_fff')
    $candidateFile = Join-Path $BackupDir ('kay_model_settings_candidate_' + $stamp + '.env')
    [IO.File]::WriteAllText($candidateFile, $candidate, $encoding)
    $env:DATABASE_URL = $null
    $env:EXAM_TRANSCRIPTION_MODELS_DIR = $null
    try {
        $checkConfig = (Invoke-DockerText -DockerArguments ($composeArguments + @('--env-file', $candidateFile, 'config', '--format', 'json'))) | ConvertFrom-Json
        $modelMount = @($checkConfig.services.'transcription-worker'.volumes | Where-Object { $_.target -eq '/models/transcription' })
        $candidateUrl = Get-ComposeLiteral -Value $checkConfig.services.'transcription-worker'.environment.DATABASE_URL
        if ($candidateUrl -cne $runtimeUrl -or $modelMount.Count -ne 1 -or
            [IO.Path]::GetFullPath((Get-ComposeLiteral -Value $modelMount[0].source)) -ne $ModelDir) {
            throw 'Candidate settings did not preserve the database connection and model path. The original .env was not changed.'
        }
    } finally {
        $env:DATABASE_URL = $runtimeUrl
        $env:EXAM_TRANSCRIPTION_MODELS_DIR = $ModelDir
    }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($envFile)) -cne [Convert]::ToBase64String($originalBytes)) {
        throw 'The private .env changed during setup. It was not overwritten.'
    }
    $envBackup = Join-Path $BackupDir ('kay_before_model_settings_' + $stamp + '.env')
    if (Test-Path -LiteralPath $envBackup) { throw 'The proposed private backup filename already exists.' }
    [IO.File]::Replace($candidateFile, $envFile, $envBackup)
    Write-Host 'Saved the verified database connection and model directory in private .env; the previous file is backed up outside Git.'

    if ($NoStartWorker) {
        Write-Host 'Model and decoder checks passed. Worker startup was skipped; saved settings use one model CPU thread and a 1 GB memory limit.'
        return
    }
    Invoke-DockerChecked -DockerArguments ($composeArguments + @('up', '-d', '--no-deps', 'transcription-worker'))
    $workerId = (Invoke-DockerText -DockerArguments ($composeArguments + @('ps', '-q', 'transcription-worker'))).Trim()
    if (-not $workerId) { throw 'The worker container was not found after startup.' }
    $running = (Invoke-DockerText -DockerArguments @('inspect', '--format', '{{.State.Running}}', $workerId)).Trim()
    if ($running -ne 'true') { throw 'The worker is not running. Inspect its container logs.' }
    Write-Host 'The local speech model loaded and the transcription worker is running.'
    Write-Host 'Recording activation still requires a retention end date and verification of the backend recording-volume mount.'
    Write-Host 'No database migration, Git commit/push, or restart of DB, Ollama or the existing backend was performed.'
} finally {
    $env:DATABASE_URL = $oldDbVariable
    $env:EXAM_TRANSCRIPTION_MODELS_DIR = $oldModelVariable
    $env:EXAM_TRANSCRIPTION_CPU_THREADS = $oldThreadVariable
    $env:EXAM_TRANSCRIPTION_MEMORY_LIMIT = $oldMemoryVariable
    Set-Location -LiteralPath $oldLocation
}
