// Real generated audio codec exercise, with no camera, microphone, display
// capture or speakers. The source connects ONLY to createMediaStreamDestination.
// Native file-only speech is exercised on Windows; no session/token/DB is forged.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const require = createRequire(process.env.AVATAR_NODE_MODULES_PATH
  ? path.join(path.resolve(process.env.AVATAR_NODE_MODULES_PATH), 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const frontend = fileURLToPath(new URL('..', import.meta.url));
const root = path.dirname(frontend.replace(/[\\/]$/, ''));
const cache = path.join(root, '.cache');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(path.join(cache, 'speech-mediarecorder-'));
const native = process.platform === 'win32';
const python = path.join(root, '.venv', native ? 'Scripts/python.exe' : 'bin/python');
const execute = promisify(execFile);
const nativeCode = `
import asyncio,json,sys,time
from pathlib import Path
from backend.app.windows_speech import probe_native,invoke_native
from backend.app.speech_adapters import _validate_audio
operation,target=sys.argv[1],Path(sys.argv[2])
async def main():
    started=time.monotonic()
    probe=probe_native()
    if probe is None: raise RuntimeError('Native file speech metadata unavailable')
    executable,voices,recognizers=probe
    if operation=='synthesize':
        voice='Microsoft David Desktop'
        if voice not in voices: raise RuntimeError('Verified synthetic fixture voice unavailable')
        await invoke_native(executable,{'operation':'synthesize','text':'The library contains books about computer science.','voice':voice,'rate':0,'output_path':str(target)})
        print(json.dumps({'duration':_validate_audio(target.read_bytes(),'audio/wav'),'seconds':time.monotonic()-started}))
    else:
        duration=_validate_audio(target.read_bytes(),'audio/wav')
        if not recognizers: raise RuntimeError('Native file recognizer unavailable')
        result=await invoke_native(executable,{'operation':'transcribe','input_path':str(target),'recognizer':recognizers[0]})
        print(json.dumps({'duration':duration,'text':result['text'],'seconds':time.monotonic()-started}))
asyncio.run(main())
`;
async function nativeFile(operation, target) {
  const { stdout } = await execute(python, ['-c', nativeCode, operation, target], {
    cwd: root, env: { ...process.env, PYTHONPATH: root }, windowsHide: true,
    timeout: 45000, maxBuffer: 128 * 1024,
  });
  return JSON.parse(stdout);
}

let browser;
try {
  let fixtureBase64 = null, synthesis = null;
  if (native) {
    const input = path.join(temporary, 'generated-native-input.wav');
    synthesis = await nativeFile('synthesize', input);
    fixtureBase64 = (await readFile(input)).toString('base64');
  }
  const bundle = await build({ stdin: { contents: `import {encodeSpeechWave,speechBlobToWave,prepareSpeechAudio} from './src/components/exam/speechWave';
    window.speechWave={encodeSpeechWave,speechBlobToWave,prepareSpeechAudio};`, resolveDir: frontend, loader: 'ts' },
    bundle: true, write: false, logLevel: 'silent' });
  browser = await chromium.launch({ headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    executablePath: process.env.AVATAR_CHROME_PATH || (native ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined) });
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Generated speech codec check</title>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const decoded = await page.evaluate(async () => {
    const { encodeSpeechWave, speechBlobToWave, prepareSpeechAudio } = window.speechWave;
    const input = encodeSpeechWave(new Float32Array(1600).map((_, index) => Math.sin(index/20)*0.1));
    const wav = await speechBlobToWave(input);
    const view = new DataView(await wav.arrayBuffer());
    let rejected = false;
    try { await prepareSpeechAudio(new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3])], { type: 'audio/webm' }), ['audio/wav']); }
    catch { rejected = true; }
    return { type: wav.type, bytes: wav.size, rate: view.getUint32(24,true), channels: view.getUint16(22,true), rejected };
  });
  assert.deepEqual(decoded, { type:'audio/wav', bytes:3244, rate:16000, channels:1, rejected:true });
  console.log('PASS actual offline generated-WAV decode/encode and corrupt compressed-data rejection');

  const captured = await page.evaluate(async (spokenFixture) => {
    const started = performance.now();
    const devices = { getUserMedia:0, getDisplayMedia:0, speakerConnections:0 };
    Object.defineProperty(navigator, 'mediaDevices', { configurable:true, value:{
      getUserMedia(){ devices.getUserMedia++; throw new Error('Real capture forbidden'); },
      getDisplayMedia(){ devices.getDisplayMedia++; throw new Error('Real display capture forbidden'); },
    } });
    const audio = new AudioContext({ sampleRate:48000 });
    const sink = audio.createMediaStreamDestination();
    const originalConnect = AudioNode.prototype.connect;
    // A test guard rejects every AudioDestinationNode connection. MediaStream
    // destination is an owned generated stream, with no speaker connection.
    AudioNode.prototype.connect = function(target, ...arguments_) {
      if (target instanceof AudioDestinationNode) {
        devices.speakerConnections++;
        throw new Error('Speaker output forbidden');
      }
      return originalConnect.call(this, target, ...arguments_);
    };
    let source;
    const generatedTracks = sink.stream.getTracks();
    try {
      let expectedDuration;
      if (spokenFixture) {
        const bytes = Uint8Array.from(atob(spokenFixture), value=>value.charCodeAt(0));
        const buffer = await audio.decodeAudioData(bytes.buffer);
        source = audio.createBufferSource(); source.buffer = buffer;
        expectedDuration = buffer.duration;
      } else {
        source = audio.createOscillator(); source.frequency.value = 440;
        expectedDuration = 0.4;
      }
      source.connect(sink);
      const mime = ['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if (!mime) throw new Error('This browser lacks the real WebM recorder under test');
      const chunks = [];
      const recorder = new MediaRecorder(sink.stream, { mimeType:mime, audioBitsPerSecond:64000 });
      recorder.ondataavailable = event=>{ if(event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve,reject)=>{ recorder.onstop=resolve;recorder.onerror=reject; });
      const ended = new Promise(resolve=>{ source.onended=resolve; });
      await audio.resume();
      recorder.start(100);
      source.start(audio.currentTime+0.05);
      if (!spokenFixture) source.stop(audio.currentTime+0.45);
      await ended;
      await new Promise(resolve=>setTimeout(resolve,200));
      recorder.stop(); await stopped;
      const webm = new Blob(chunks,{type:mime});
      const webmBytes = new Uint8Array(await webm.arrayBuffer());
      const wave = await window.speechWave.prepareSpeechAudio(webm,['audio/wav']);
      const waveBytes = new Uint8Array(await wave.arrayBuffer());
      const header = new DataView(waveBytes.buffer);
      const pcmBytes = header.getUint32(40,true);
      return { mime, webmSize:webm.size, webmHeader:Array.from(webmBytes.slice(0,4)),
        waveSize:wave.size, rate:header.getUint32(24,true), channels:header.getUint16(22,true),
        bits:header.getUint16(34,true), duration:pcmBytes/32000, expectedDuration,
        devices, wave:Array.from(waveBytes), seconds:(performance.now()-started)/1000 };
    } finally {
      AudioNode.prototype.connect=originalConnect;
      source?.disconnect();generatedTracks.forEach(track=>track.stop());await audio.close();
    }
  }, fixtureBase64);
  assert.equal(captured.devices.getUserMedia,0);
  assert.equal(captured.devices.getDisplayMedia,0);
  assert.equal(captured.devices.speakerConnections,0);
  assert.deepEqual(captured.webmHeader,[0x1a,0x45,0xdf,0xa3]);
  assert.equal(captured.rate,16000);assert.equal(captured.channels,1);assert.equal(captured.bits,16);
  assert.ok(captured.webmSize>1000);assert.equal(captured.waveSize,captured.wave.length);
  assert.ok(captured.duration >= captured.expectedDuration-0.05 && captured.duration <= captured.expectedDuration+1);
  const converted = path.join(temporary,'converted-recorder-output.wav');
  await writeFile(converted,Buffer.from(captured.wave));
  console.log('PASS real generated MediaRecorder WebM/Opus converts to mono16kHz PCM WAV with zero device/speaker calls');
  let recognition = null;
  if(native){
    recognition = await nativeFile('recognize',converted);
    assert.equal(recognition.duration,captured.duration);
    assert.match(recognition.text.toLowerCase(),/library/);
    assert.match(recognition.text.toLowerCase(),/computer science/);
    console.log('PASS generated native spoken WAV -> real browser WebM/Opus -> PCM WAV -> actual backend validation and native file ASR');
  }else{
    console.log('NOT RUN native Windows file ASR on this non-Windows host; generated oscillator codec conversion only');
  }
  const summary={nativeFixture:native,webmBytes:captured.webmSize,wavBytes:captured.waveSize,
    durationSeconds:captured.duration,rate:captured.rate,channels:captured.channels,
    browserSeconds:captured.seconds,synthesisSeconds:synthesis?.seconds ?? null,
    nativeValidationAndAsrSeconds:recognition?.seconds ?? null,deviceCalls:captured.devices,
    syntheticFixtureWordsRecognized:recognition ? true : null};
  console.log(JSON.stringify(summary));
}finally{
  if(browser)await browser.close();
  const target=path.resolve(temporary);
  assert.equal(path.dirname(target),path.resolve(cache));
  assert.ok(path.basename(target).startsWith('speech-mediarecorder-'));
  await rm(target,{recursive:true,force:true});
}
