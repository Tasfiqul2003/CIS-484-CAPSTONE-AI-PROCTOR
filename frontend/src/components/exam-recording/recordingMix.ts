// Mix microphone and examiner audio without routing speakers into a suspended context.
export type RecordingMix = {
  stream: MediaStream;
  attach: (element: HTMLMediaElement) => void;
  /** Called in the same user gesture as media.play() when browser audio needs unlocking. */
  resume: () => Promise<void>;
  close: () => void;
};
export function createRecordingMix(source: MediaStream): RecordingMix | null {
  if (typeof AudioContext === 'undefined' || source.getAudioTracks().length === 0) return null;
  try {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(source).connect(destination);
    const attached = new WeakSet<HTMLMediaElement>();
    const waiting = new Set<HTMLMediaElement>();
    const connect = () => {
      if (context.state !== 'running') return;
      for (const element of waiting) {
        if (!attached.has(element)) {
          const voice = context.createMediaElementSource(element);
          voice.connect(destination); voice.connect(context.destination); attached.add(element);
        }
        waiting.delete(element);
      }
    };
    context.addEventListener('statechange', connect);
    const resume = async () => {
      if (context.state === 'closed') throw new Error('The recording audio context was closed.');
      if (context.state !== 'running') await context.resume();
      connect();
    };
    void resume().catch(() => undefined);
    return {
      stream: new MediaStream([...source.getVideoTracks(), ...destination.stream.getAudioTracks()]),
      attach(element) {
        if (attached.has(element) || context.state === 'closed') return;
        waiting.add(element); connect();
      },
      resume,
      close() { waiting.clear(); context.removeEventListener('statechange', connect); void context.close().catch(() => undefined); },
    };
  } catch { return null; }
}
