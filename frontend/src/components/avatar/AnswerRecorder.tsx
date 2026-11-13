import { useEffect, useRef, useState } from "react";
import { transcribeAnswer } from "./avatarService";

type Props = {
  sessionId: string;
  token: string;
  disabled?: boolean;
  /** Receives the transcript; the student reviews and edits it before submitting. */
  onTranscript: (text: string) => void;
  onRecordingChange?: (recording: boolean) => void;
};

const MAX_SECONDS = 180;

function pickMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return options.find(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

/** "Speak your answer" button: records the microphone, then fills the answer box with the transcript. */
export default function AnswerRecorder({ sessionId, token, disabled = false, onTranscript, onRecordingChange }: Props) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [message, setMessage] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  const release = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  };

  useEffect(() => () => { recorder.current?.state === "recording" && recorder.current.stop(); release(); }, []);
  useEffect(() => { onRecordingChange?.(state === "recording"); }, [state, onRecordingChange]);

  const start = async () => {
    setMessage("");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
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
      const audio = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
      chunks.current = [];
      if (audio.size < 1000) { setState("idle"); setMessage("No speech was recorded. Try again, or type your answer."); return; }
      setState("transcribing");
      try {
        const text = await transcribeAnswer(sessionId, token, audio);
        if (text) { onTranscript(text); setMessage("Transcript added. Check it before you submit."); }
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
    timer.current = window.setTimeout(() => media.state === "recording" && media.stop(), MAX_SECONDS * 1000);
  };

  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); };

  if (!supported) return <p className="answer-recorder-note">Spoken answers are not supported in this browser. Type your answer.</p>;

  return <div className="answer-recorder">
    {state === "recording"
      ? <button type="button" className="answer-recorder-button is-recording" onClick={stop}>Stop and transcribe</button>
      : <button type="button" className="answer-recorder-button" onClick={() => void start()}
          disabled={disabled || state === "transcribing"}>{state === "transcribing" ? "Transcribing…" : "Speak your answer"}</button>}
    <span role="status" className="answer-recorder-status">
      {state === "recording" ? `Recording… (up to ${MAX_SECONDS / 60} minutes)` : message}
    </span>
  </div>;
}
