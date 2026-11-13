import { useCallback, useEffect, useRef, useState } from "react";
import { streamAvatarSpeech } from "./avatarService";
import type { AvatarClip } from "./avatarService";

type Props = {
  sessionId: string;
  token: string;
  /** The question text the avatar should say. A new sequence number always replays. */
  text: string;
  sequence: number;
  /** Stop talking (for example while the student records or the answer is submitting). */
  hold?: boolean;
};

/** Plays the professor avatar's clips for the current question, sentence by sentence. */
export default function AvatarVideoStage({ sessionId, token, text, sequence, hold = false }: Props) {
  const [queue, setQueue] = useState<AvatarClip[]>([]);
  const [status, setStatus] = useState<"idle" | "preparing" | "speaking" | "blocked" | "error">("idle");
  const [message, setMessage] = useState("");
  const [caption, setCaption] = useState("");
  const video = useRef<HTMLVideoElement | null>(null);
  const request = useRef<AbortController | null>(null);

  const say = useCallback((words: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setQueue([]); setCaption(""); setMessage(""); setStatus("preparing");
    let received = 0;
    void streamAvatarSpeech(sessionId, token, words, clip => {
      if (controller.signal.aborted) return;
      received += 1;
      setQueue(current => [...current, clip]);
    }, controller.signal).then(() => {
      if (!controller.signal.aborted && received === 0) setStatus("idle");
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The avatar is unavailable. The question is shown below.");
    });
  }, [sessionId, token]);

  useEffect(() => {
    if (!sessionId || !token || !text) return;
    say(text);
    return () => request.current?.abort();
  }, [sessionId, token, text, sequence, say]);

  // Play the head of the queue; move on when it ends.
  useEffect(() => {
    const element = video.current;
    const clip = queue[0];
    if (!element || !clip || hold) return;
    if (element.getAttribute("src") !== clip.url) element.src = clip.url;
    setCaption(clip.text);
    element.play().then(() => setStatus("speaking")).catch(() => setStatus("blocked"));
  }, [queue, hold]);

  useEffect(() => {
    if (hold) video.current?.pause();
  }, [hold]);

  const ended = () => {
    setQueue(current => {
      const rest = current.slice(1);
      if (rest.length === 0) setStatus("idle");
      return rest;
    });
  };

  return <section className="avatar-video-stage" aria-label="Examiner">
    <video ref={video} className="avatar-video" playsInline preload="auto" onEnded={ended}
      aria-describedby="avatar-video-caption" />
    <p id="avatar-video-caption" className="avatar-video-caption" aria-live="polite">
      {status === "preparing" ? "The examiner is preparing the question…" : caption}
    </p>
    <div className="avatar-video-controls">
      {status === "blocked" && <button type="button" onClick={() => {
        video.current?.play().then(() => setStatus("speaking")).catch(() => setStatus("blocked"));
      }}>Play the examiner</button>}
      {(status === "idle" || status === "error") && <button type="button" onClick={() => say(text)}>Replay question</button>}
    </div>
    {message && <p role="status" className="avatar-video-message">{message}</p>}
  </section>;
}
