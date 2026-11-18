/** One bounded listening turn. All tracks are owned clones; assessed capture is untouched. */
export async function captureOralAnswer(shared: MediaStream | null, signal: AbortSignal,
  onLevel: (value: number) => void): Promise<Blob | null> {
  const check = () => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  check();
  const tracks = shared?.getAudioTracks().filter(track => track.readyState === 'live') ?? [];
  const source = tracks.length ? new MediaStream(tracks.map(track => track.clone()))
    : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | null = null;
  try {
    check();
    if (!source.getAudioTracks().some(track => track.readyState === 'live' && track.enabled && !track.muted))
      throw new Error('The permitted microphone is muted or unavailable.');
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser cannot record spoken answers.');
    context = new AudioContext();
    await context.resume(); check();
    if (context.state !== 'running') throw new Error('Microphone analysis is paused by the browser.');
    const analyser = context.createAnalyser(); analyser.fftSize = 1024;
    context.createMediaStreamSource(source).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const recorder = new MediaRecorder(source, { mimeType, audioBitsPerSecond: 64000 });
    return await new Promise<Blob | null>((resolve, reject) => {
      let chunks: Blob[] = [], bytes = 0, heard = false, loudMs = 0;
      const started = performance.now();
      let lastTick = started, lastLoud = started, floor = 0.01, done = false;
      const finish = (error?: Error) => {
        if (done) return; done = true;
        clearInterval(timer); signal.removeEventListener('abort', abort);
        source.getAudioTracks().forEach(track => { track.removeEventListener('ended', ended); track.removeEventListener('mute', ended); });
        recorder.ondataavailable = null; recorder.onstop = null; recorder.onerror = null;
        if (recorder.state === 'recording') recorder.stop();
        if (error) reject(error);
        else resolve(heard ? new Blob(chunks, { type: mimeType }) : null);
        chunks = [];
      };
      const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
      const ended = () => finish(new Error('The microphone was disconnected.'));
      signal.addEventListener('abort', abort, { once: true });
      source.getAudioTracks().forEach(track => { track.addEventListener('ended', ended, { once: true }); track.addEventListener('mute', ended, { once: true }); });
      recorder.ondataavailable = event => {
        bytes += event.data.size;
        if (bytes > 10 * 1024 * 1024) finish(new Error('This spoken response exceeded the recording limit.'));
        else chunks.push(event.data);
      };
      recorder.onstop = () => finish();
      recorder.onerror = () => finish(new Error('Spoken answer capture was interrupted.'));
      const timer = window.setInterval(() => {
        if (done || recorder.state !== 'recording') return;
        analyser.getFloatTimeDomainData(buffer);
        const value = Math.sqrt(buffer.reduce((sum, sample) => sum + sample * sample, 0) / buffer.length);
        const now = performance.now();
        if (now - started < 500) floor = Math.min(0.03, Math.max(floor, value));
        if (value > Math.max(0.01, floor * 3)) {
          loudMs += Math.min(100, now - lastTick); lastLoud = now;
          if (loudMs >= 300) heard = true;
        }
        lastTick = now; onLevel(Math.min(1, value * 8));
        if ((heard && now - lastLoud >= 3000) || (!heard && now - started >= 20000)
            || now - started >= 110000) recorder.stop();
      }, 50);
      try { recorder.start(1000); } catch (error) { finish(error instanceof Error ? error : new Error('Microphone unavailable.')); }
      if (signal.aborted) abort();
    });
  } finally {
    source.getTracks().forEach(track => track.stop());
    await context?.close().catch(() => undefined); onLevel(0);
  }
}
