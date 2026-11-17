// Mixes the examiner's voice into the exam recording.
// The recording is the student's camera and microphone. The browser's echo cancellation removes the
// examiner's voice coming out of the speakers, so without this the professor hears only the student.

export type RecordingMix = {
  /** Camera video plus one audio track: microphone + examiner. Give this to the MediaRecorder. */
  stream: MediaStream;
  /** Routes an examiner <video> element into the recording; it keeps playing on the speakers. */
  attach: (element: HTMLMediaElement) => void;
  close: () => void;
};

export function createRecordingMix(source: MediaStream): RecordingMix | null {
  if (typeof AudioContext === "undefined" || source.getAudioTracks().length === 0) return null;
  try {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(source).connect(destination);
    void context.resume().catch(() => undefined);
    const attached = new WeakSet<HTMLMediaElement>();
    return {
      stream: new MediaStream([...source.getVideoTracks(), ...destination.stream.getAudioTracks()]),
      attach(element) {
        if (attached.has(element) || context.state === "closed") return;
        attached.add(element);
        const voice = context.createMediaElementSource(element);
        voice.connect(destination);
        voice.connect(context.destination);
      },
      close() { void context.close().catch(() => undefined); },
    };
  } catch {
    return null; // Fall back to recording the camera and microphone only.
  }
}
