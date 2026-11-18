const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_SECONDS = 120;
const SAMPLE_RATE = 16000;

/** PCM WAV bytes, never playback: mono, 16 kHz and signed16-bit little-endian. */
export function encodeSpeechWave(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  if (sampleRate !== SAMPLE_RATE || !samples.length || samples.length > sampleRate * MAX_SECONDS) {
    throw new Error('Speech draft duration or sample rate is unsupported. Type your answer.');
  }
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  ascii(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Offline decode/resampling has no speakers or input devices. */
export async function speechBlobToWave(blob: Blob): Promise<Blob> {
  if (!blob.size || blob.size > MAX_AUDIO_BYTES || typeof OfflineAudioContext === 'undefined') {
    throw new Error('This browser cannot prepare the speech audio format. Type your answer.');
  }
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('The browser could not decode the speech draft. Try again or type your answer.');
  }
  if (!decoded.length || decoded.duration > MAX_SECONDS || decoded.numberOfChannels > 2
      || decoded.sampleRate !== SAMPLE_RATE) {
    throw new Error('The decoded speech draft exceeds supported duration or format. Type your answer.');
  }
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let frame = 0; frame < mono.length; frame++) mono[frame] += data[frame] / decoded.numberOfChannels;
  }
  return encodeSpeechWave(mono);
}

export async function prepareSpeechAudio(blob: Blob, accepted: readonly string[]): Promise<Blob> {
  const type = blob.type.split(';', 1)[0].trim().toLowerCase();
  if (accepted.includes(type)) return blob;
  if (accepted.includes('audio/wav')) return speechBlobToWave(blob);
  throw new Error('The speech provider does not accept this browser audio format. Type your answer.');
}
