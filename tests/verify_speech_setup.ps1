$ErrorActionPreference = 'Stop'
$testRoot = Join-Path (Join-Path $env:USERPROFILE 'AppData\Local\Temp') ('speech-setup-test-' + [Guid]::NewGuid().ToString('N'))
$testRepo = Join-Path $testRoot 'repo'
$testModels = Join-Path $testRoot 'models'
$testBackups = Join-Path $testRoot 'backups'
New-Item -ItemType Directory -Path $testRepo, $testModels, $testBackups -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $testRepo 'backend') -Force | Out-Null
$testRequirements = Join-Path $testRepo 'backend\requirements-transcription.txt'
$originalRequirements = "-r requirements.txt`r`nfaster-whisper==1.2.1`r`n"
foreach ($name in @('model.bin', 'config.json', 'tokenizer.json')) {
    [IO.File]::WriteAllText((Join-Path $testModels $name), 'synthetic test fixture')
}
$testEnv = Join-Path $testRepo '.env'
$originalContent = "POSTGRES_PASSWORD=SYNTHETIC_NOT_A_SECRET`r`nEXAM_VIDEO_RETENTION_UNTIL=`r`n"
$global:KaySpeechFixture = @{ Calls=@(); WrongDb=$false; FailModel=$false; FailDecoder=$false; BadCandidate=$false;
    RuntimeUrl='postgresql+psycopg2://synthetic:fixture@db:5432/examdb'; ModelDir=$testModels }

function global:docker {
    $toolArguments = @($args)
    $global:KaySpeechFixture.Calls += ,$toolArguments
    $global:LASTEXITCODE = 0
    if ($toolArguments[0] -eq 'exec') {
        if ($toolArguments[2] -eq 'printenv') { return $global:KaySpeechFixture.RuntimeUrl }
        return '{"host":"db","database":"examdb"}'
    }
    if ($toolArguments[0] -eq 'inspect') {
        if ($toolArguments[2] -eq '{{json .Config.Labels}}') { return '{"com.docker.compose.project":"synthetic-project"}' }
        return 'true'
    }
    if ($toolArguments -contains 'config') {
        $url = ''
        if ($global:KaySpeechFixture.WrongDb) { $url = 'synthetic-other-connection' }
        if ($toolArguments -contains '--env-file') {
            $url = $global:KaySpeechFixture.RuntimeUrl
            if ($global:KaySpeechFixture.BadCandidate) { $url = 'synthetic-mismatch' }
        }
        return (@{name='synthetic-project'; services=@{'transcription-worker'=@{environment=@{DATABASE_URL=$url};
            volumes=@(@{target='/models/transcription';source=$global:KaySpeechFixture.ModelDir})}}} | ConvertTo-Json -Depth 8 -Compress)
    }
    if ($toolArguments -contains '--check' -and $global:KaySpeechFixture.FailModel) { $global:LASTEXITCODE = 1; return }
    if ($toolArguments -contains '-c' -and ($toolArguments[-1] -match 'from faster_whisper.audio import decode_audio') -and $global:KaySpeechFixture.FailDecoder) { $global:LASTEXITCODE = 1; return }
    if ($toolArguments -contains 'ps') { return 'synthetic-worker' }
}

function Assert-True { param([bool]$Condition,[string]$Message) if (-not $Condition) { throw $Message } }
function Reset-Fixture {
    $global:KaySpeechFixture.Calls=@(); $global:KaySpeechFixture.WrongDb=$false
    $global:KaySpeechFixture.FailModel=$false; $global:KaySpeechFixture.FailDecoder=$false; $global:KaySpeechFixture.BadCandidate=$false
    [IO.File]::WriteAllText($testEnv,$originalContent,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($testRequirements,$originalRequirements,[Text.UTF8Encoding]::new($false))
}
function Run-Setup {
    param([switch]$NoStartWorker)
    & (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\Setup_Speech_Model.ps1') -Repo $testRepo -ModelDir $testModels -BackupDir $testBackups -Apply -SkipSyntheticSpeechTest -NoStartWorker:$NoStartWorker
}

Reset-Fixture
Run-Setup
$after = [IO.File]::ReadAllText($testEnv)
Assert-True ($after.Contains('POSTGRES_PASSWORD=SYNTHETIC_NOT_A_SECRET')) 'An unrelated setting changed.'
Assert-True ($after.Contains('EXAM_VIDEO_RETENTION_UNTIL=')) 'Retention was changed.'
Assert-True ($after.Contains('DATABASE_URL=') -and $after.Contains('EXAM_TRANSCRIPTION_MODELS_DIR=')) 'The verified settings were not saved.'
Assert-True ($after.Contains("EXAM_TRANSCRIPTION_CPU_THREADS='1'") -and $after.Contains("EXAM_TRANSCRIPTION_MEMORY_LIMIT='1g'")) 'Laptop resource settings were not saved.'
Assert-True (@($global:KaySpeechFixture.Calls | Where-Object { $_ -contains 'stop' }).Count -eq 0) 'Existing services were stopped.'
Assert-True (@($global:KaySpeechFixture.Calls | Where-Object { $_ -contains 'up' }).Count -eq 1) 'Expected only the speech worker to start.'
Write-Host 'PASS: successful setup preserves unrelated settings/retention and starts only the speech worker.'
Assert-True ([IO.File]::ReadAllText($testRequirements).Contains('av==18.1.0')) 'Compatible PyAV was not pinned.'
$dependencyBackups = @(Get-ChildItem -LiteralPath $testBackups -Filter 'kay_before_decoder_requirements_*.txt')
Assert-True ($dependencyBackups.Count -eq 1 -and [IO.File]::ReadAllText($dependencyBackups[0].FullName) -ceq $originalRequirements) 'Exact dependency backup was not retained.'
Write-Host 'PASS: compatible decoder requirements and an exact original backup were saved.'

$beforeRepeat = [IO.File]::ReadAllBytes($testRequirements)
Run-Setup
Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($testRequirements)) -ceq [Convert]::ToBase64String($beforeRepeat)) 'Rerunning changed compatible requirements.'
Assert-True (@(Get-ChildItem -LiteralPath $testBackups -Filter 'kay_before_decoder_requirements_*.txt').Count -eq 1) 'Rerunning unnecessarily backed up the same dependencies.'
Write-Host 'PASS: setup can resume without repatching compatible requirements or downloading the model again.'

Reset-Fixture
$global:KaySpeechFixture.FailDecoder=$true
$failed=$false
try { Run-Setup } catch { $failed=$true }
Assert-True ($failed -and [IO.File]::ReadAllText($testEnv) -ceq $originalContent) 'Decoder failure did not preserve settings.'
Assert-True (@($global:KaySpeechFixture.Calls | Where-Object { $_ -contains 'up' -or $_ -contains '--check' }).Count -eq 0) 'Setup continued past a failed decoder.'
Write-Host 'PASS: decoder failures block model setup and worker startup, preserving private configuration.'

Reset-Fixture
[IO.File]::WriteAllText($testRequirements,"-r requirements.txt`nfaster-whisper==99`n")
$failed=$false
try { Run-Setup } catch { $failed=$true }
Assert-True ($failed -and [IO.File]::ReadAllText($testRequirements).Contains('==99')) 'Unknown dependencies were overwritten.'
Assert-True ($global:KaySpeechFixture.Calls.Count -eq 0) 'Unknown dependencies reached Docker.'
Write-Host 'PASS: unknown dependency edits are preserved and rejected before Docker.'

Reset-Fixture
$global:KaySpeechFixture.WrongDb=$true
$failed=$false
try { Run-Setup } catch { $failed=$true }
Assert-True ($failed -and [IO.File]::ReadAllText($testEnv) -ceq $originalContent) 'A different configured DB was not rejected.'
Write-Host 'PASS: a mismatched database is rejected before configuration changes.'

Reset-Fixture
$global:KaySpeechFixture.FailModel=$true
$failed=$false
try { Run-Setup } catch { $failed=$true }
Assert-True ($failed -and [IO.File]::ReadAllText($testEnv) -ceq $originalContent) 'Model failure did not preserve the original settings.'
Assert-True (@($global:KaySpeechFixture.Calls | Where-Object { $_ -contains 'up' }).Count -eq 0) 'Worker started after model failure.'
Write-Host 'PASS: model failure blocks worker startup and preserves existing configuration.'

Reset-Fixture
$global:KaySpeechFixture.BadCandidate=$true
$failed=$false
try { Run-Setup } catch { $failed=$true }
Assert-True ($failed -and [IO.File]::ReadAllText($testEnv) -ceq $originalContent) 'A misparsed candidate replaced the original settings.'
Write-Host 'PASS: candidate settings are verified before replacing private .env.'

Reset-Fixture
Run-Setup -NoStartWorker
Assert-True (@($global:KaySpeechFixture.Calls | Where-Object { $_ -contains 'up' }).Count -eq 0) 'NoStartWorker unexpectedly started a service.'
Assert-True ([IO.File]::ReadAllText($testEnv).Contains("EXAM_TRANSCRIPTION_CPU_THREADS='1'")) 'Provision-only setup did not save conservative settings.'
Write-Host 'PASS: provision-only setup validates the model and leaves the worker stopped.'
