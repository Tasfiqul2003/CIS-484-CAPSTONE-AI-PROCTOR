/** Play an already-generated clip, including browser-gesture recovery. Never regenerates speech. */
export function playExaminerAudio(element: HTMLMediaElement, url: string, signal: AbortSignal,
  options: { resumeAudio?: () => Promise<void>; onReady: (retry: (() => void) | null) => void;
    onStarted: () => void; onBlocked: (message: string) => void;
    startTimeoutMs?: number; playbackTimeoutMs?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false, started = false;
    let playbackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (done) return; done = true;
      clearTimeout(startTimer); clearTimeout(playbackTimer);
      element.removeEventListener('ended', ended); element.removeEventListener('error', failed);
      signal.removeEventListener('abort', abort); options.onReady(null);
      if (error) { element.pause(); reject(error); } else resolve();
    };
    const ended = () => started ? finish() : finish(new Error('Audio ended before the recording audio output was ready. Resume the spoken exam.'));
    const failed = () => finish(new Error('The generated examiner audio could not be decoded. Try resuming the spoken exam.'));
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'));
    const startTimer = setTimeout(() => finish(new Error('Browser audio did not start. Resume the spoken exam, then select Play examiner audio.')),
      options.startTimeoutMs ?? 30000);
    const attempt = () => {
      if (done || signal.aborted) return;
      // Both calls happen synchronously in the button gesture, before any await.
      // A fetched/regenerated clip here would lose that browser permission window.
      try {
        if (element.ended) element.currentTime = 0;
        const resumed = options.resumeAudio?.() ?? Promise.resolve();
        const played = element.play();
        void Promise.all([resumed, played]).then(() => {
          if (done || signal.aborted || started) return;
          started = true; clearTimeout(startTimer); options.onReady(null); options.onStarted();
          playbackTimer = setTimeout(() => finish(new Error('Examiner audio playback stalled. Resume the spoken exam.')),
            options.playbackTimeoutMs ?? 150000);
        }).catch(error => {
          if (done || signal.aborted) return;
          if (error?.name === 'NotAllowedError' || error?.name === 'AbortError')
            options.onBlocked('Your browser paused examiner audio. Select Play examiner audio to continue.');
          else finish(new Error('Examiner audio could not start. Resume the spoken exam to try again.'));
        });
      } catch { finish(new Error('Examiner audio could not start. Resume the spoken exam to try again.')); }
    };
    element.addEventListener('ended', ended); element.addEventListener('error', failed);
    signal.addEventListener('abort', abort, { once: true });
    element.src = url;
    options.onReady(attempt);
    if (signal.aborted) abort(); else attempt();
  });
}
