# File-only native speech worker. Never use default input/output audio devices.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    $raw = [Console]::In.ReadToEnd()
    if ($raw.Length -gt 100000) { throw 'request limit' }
    $request = $raw | ConvertFrom-Json
    Add-Type -AssemblyName System.Speech
    if ($request.operation -eq 'probe') {
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | Select-Object -First 64 | ForEach-Object { $_.VoiceInfo.Name })
        } finally { $synth.Dispose() }
        $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq 'en-US' } | Select-Object -First 16 | ForEach-Object { $_.Id })
        @{ ok=$true; voices=$voices; recognizers=$recognizers } | ConvertTo-Json -Compress
    } elseif ($request.operation -eq 'synthesize') {
        if ($request.text -isnot [string] -or $request.text.Length -lt 1 -or $request.text.Length -gt 8000) { throw 'text limit' }
        if ($request.rate -lt -10 -or $request.rate -gt 10) { throw 'rate limit' }
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            $synth.SelectVoice([string]$request.voice)
            $synth.Rate = [int]$request.rate
            $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
            $synth.SetOutputToWaveFile([string]$request.output_path, $format)
            $synth.Speak([string]$request.text)
        } finally { $synth.Dispose() }
        @{ ok=$true } | ConvertTo-Json -Compress
    } elseif ($request.operation -eq 'transcribe') {
        # Multiple dictation utterances until file-end, with a bounded wait. C#
        # handlers run independently of the PowerShell runspace/event pipeline.
        $source = @'
using System;
using System.Speech.Recognition;
using System.Collections.Generic;
using System.Threading;
public static class CybrosFileDictation {
    public static string Read(string path, string id) {
        using (var done = new ManualResetEvent(false))
        using (var recognizer = new SpeechRecognitionEngine(id)) {
            var words = new List<string>();
            bool failed = false;
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.SetInputToWaveFile(path);
            recognizer.SpeechRecognized += (sender, e) => {
                if(e.Result != null && !String.IsNullOrWhiteSpace(e.Result.Text)) {
                    lock(words) { words.Add(e.Result.Text); }
                }
            };
            recognizer.RecognizeCompleted += (sender, e) => {
                failed = e.Error != null || e.Cancelled;
                done.Set();
            };
            recognizer.RecognizeAsync(RecognizeMode.Multiple);
            if(!done.WaitOne(25000)) {
                recognizer.RecognizeAsyncCancel();
                throw new TimeoutException();
            }
            if(failed) throw new InvalidOperationException();
            lock(words) { return String.Join(" ", words); }
        }
    }
}
'@
        Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Speech'
        $transcript = [CybrosFileDictation]::Read([string]$request.input_path, [string]$request.recognizer)
        if ($transcript.Length -gt 8000) { throw 'transcript limit' }
        @{ ok=$true; text=$transcript } | ConvertTo-Json -Compress
    } else { throw 'unsupported operation' }
} catch {
    # Never write exception text, text/audio, credentials or filesystem paths.
    @{ ok=$false; error='native_speech_failed' } | ConvertTo-Json -Compress
    exit 1
}
