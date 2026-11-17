import { useEffect, useRef, useState } from "react";
import { transcribeAnswer } from "./avatarService";

type Props = {
  sessionId: string;
  token: string;
  disabled?: boolean;
  /** Receives the transcript; the student reviews and edits it before submitting.
   *  Return false when it was a request (such as "repeat the question") rather than an answer. */
  onTranscript: (text: string) => boolean | void;
  onRecordingChange?: (recording: boolean) => void;
  /** The exam's own camera+microphone recording, if running: its microphone is reused instead of opened twice. */
  sharedStream?: MediaStream | null;
  /** Hands-free: each new value starts listening, and recording stops by itself after the student goes quiet. */
  listenSignal?: number;
  handsFree?: boolean;
};

const MAX_SECONDS = 180;
/** Hands-free timing: stop after this much quiet once speech was heard; give up if no speech starts. */
const SILENCE_MS = 3000;
const NO_SPEECH_MS = 20000;
const MIN_SPEECH_MS = 300;
const MAX_NOISE_FLOOR = 0.03;

function pickMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return options.find(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

/** Loudness (RMS) of the current audio frame, 0..1. */
function level(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.sqrt(sum / buffer.length);
}

/** "Speak your answer": records the microphone, then fills the answer box with the transcript. */
export default function AnswerRecorder({ sessionId, token, disabled = false, onTranscript, onRecordingChange,
  sharedStream = null, listenSignal = 0, handsFree = false }: Props) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [message, setMessage] = useState("");
  const [meter, setMeter] = useState(0);
  const [heard, setHeard] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const frame = useRef<number | null>(null);
  const speechHeard = useRef(false);
  const lastSignal = useRef(listenSignal);
  const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  const release = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    setMeter(0);
  };

  useEffect(() => () => { recorder.current?.state === "recording" && recorder.current.stop(); release(); }, []);
  useEffect(() => { onRecordingChange?.(state === "recording"); }, [state, onRecordingChange]);

  /** Watches the microphone level: shows a meter and, in hands-free mode, stops after the student goes quiet. */
  const watch = (media: MediaRecorder, source: MediaStream, autoStop: boolean) => {
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return; // No meter or auto-stop; the Stop button still works.
    }
    audio.current = context;
    void context.resume().catch(() => undefined);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(source).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const started = performance.now();
    // Speech has short gaps between syllables, so count total loud time and measure silence from the last loud frame.
    let floor = 0.01, loudMs = 0, lastLoud = 0, lastTick = started, lastMeter = 0;

    const tick = () => {
      if (media.state !== "recording") return;
      const now = performance.now();
      const value = level(analyser, buffer);
      // Learn the room's background noise in the first half second; speech must be clearly louder.
      // Capped, because a student who starts talking right away would otherwise set the "noise" so
      // high that their speech never counts and listening never stops.
      if (now - started < 500) floor = Math.min(MAX_NOISE_FLOOR, Math.max(floor, value));
      const loud = value > Math.max(0.01, floor * 3);
      if (now - lastMeter > 100) { setMeter(Math.min(1, value * 8)); lastMeter = now; }
      if (loud) {
        loudMs += now - lastTick;
        lastLoud = now;
        if (!speechHeard.current && loudMs >= MIN_SPEECH_MS) { speechHeard.current = true; setHeard(true); }
      }
      lastTick = now;
      const quietFor = now - (lastLoud || started);
      if (autoStop) {
        if (speechHeard.current && quietFor >= SILENCE_MS) { media.stop(); return; }
        if (!speechHeard.current && now - started >= NO_SPEECH_MS) { media.stop(); return; }
      }
      frame.current = window.requestAnimationFrame(tick);
    };
    frame.current = window.requestAnimationFrame(tick);
  };

  const start = async (auto = false) => {
    if (recorder.current?.state === "recording") return;
    setMessage("");
    speechHeard.current = false;
    setHeard(false);
    // Clones of the exam recording's audio tracks: stopping them later does not stop the exam recording.
    const liveAudio = sharedStream?.getAudioTracks().filter(track => track.readyState === "live") ?? [];
    try {
      stream.current = liveAudio.length
        ? new MediaStream(liveAudio.map(track => track.clone()))
        : await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setMessage("Microphone access was blocked. Allow the microphone in your browser, or type your answer.");
      return;
    }
    const mimeType = pickMimeType();
    const media = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    media.ondataavailable = event => { if (event.data.size > 0) chunks.current.push(event.data); };
    media.onstop = async () => {
      release();
      const recorded = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
      chunks.current = [];
      // In hands-free mode a recording with no speech is dropped instead of transcribed (Whisper invents words from silence).
      if ((auto || handsFree) && !speechHeard.current) {
        setState("idle");
        setMessage("No answer was heard. Select Speak your answer when you are ready, or type your answer.");
        return;
      }
      if (recorded.size < 1000) { setState("idle"); setMessage("No speech was recorded. Try again, or type your answer."); return; }
      setState("transcribing");
      try {
        const text = await transcribeAnswer(sessionId, token, recorded);
        if (text) setMessage(onTranscript(text) === false ? "" : "Transcript added. Check it before you submit.");
        else setMessage("Nothing was heard. Try again a little closer to the microphone, or type your answer.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Transcription failed. Type your answer instead.");
      } finally {
        setState("idle");
      }
    };
    recorder.current = media;
    media.start();
    setState("recording");
    watch(media, stream.current, handsFree);
    timer.current = window.setTimeout(() => media.state === "recording" && media.stop(), MAX_SECONDS * 1000);
  };

  // Hands-free: the exam page bumps listenSignal when the examiner finishes asking.
  useEffect(() => {
    if (listenSignal === lastSignal.current) return;
    lastSignal.current = listenSignal;
    if (handsFree && supported && !disabled && state === "idle") void start(true);
  }, [listenSignal]);

  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); };

  if (!supported) return <p className="answer-recorder-note">Spoken answers are not supported in this browser. Type your answer.</p>;

  const listening = handsFree
    ? (heard ? "Listening… pause for 3 seconds when you are finished." : "Listening… start your answer when you are ready.")
    : `Recording… (up to ${MAX_SECONDS / 60} minutes)`;

  return <div className="answer-recorder">
    {state === "recording"
      ? <button type="button" className="answer-recorder-button is-recording" onClick={stop}>{handsFree ? "I'm finished" : "Stop and transcribe"}</button>
      : <button type="button" className="answer-recorder-button" onClick={() => void start(false)}
          disabled={disabled || state === "transcribing"}>{state === "transcribing" ? "Transcribing…" : "Speak your answer"}</button>}
    {state === "recording" && <span className="answer-recorder-meter" aria-hidden="true">
      <span style={{ transform: `scaleX(${meter})` }} />
    </span>}
    <span role="status" className="answer-recorder-status">{state === "recording" ? listening : message}</span>
  </div>;
}
