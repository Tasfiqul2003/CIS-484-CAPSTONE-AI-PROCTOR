import { useCallback, useEffect, useRef, useState } from "react";
import OralExamMark from "../brand/OralExamMark";
import { fetchExaminerIdle, streamAvatarSpeech } from "./avatarService";
import type { AvatarClip } from "./avatarService";

type Props = {
  sessionId: string;
  token: string;
  /** The question text the avatar should say. A new sequence number always replays. */
  text: string;
  sequence: number;
  /** Stop talking (for example while the student records or the answer is submitting). */
  hold?: boolean;
  /** Called once after the whole question has been spoken (or could not be), e.g. to start listening. */
  onFinished?: () => void;
  /** Extra speech, such as a spoken "repeat" request or an assistance answer. Each new id is spoken once. */
  announce?: { id: number; text: string } | null;
  /** Receives the video element, so the exam recording can include the examiner's voice. */
  onVideoElement?: (element: HTMLVideoElement | null) => void;
  /** The examiner's still photo, shown while getting ready and between questions. */
  poster?: string;
  /** A short line the examiner says before this question ("Thank you."), when the server sent one. */
  lead?: string;
  /** Wait this long before speaking a new question, so the student is not spoken to the instant the page opens. */
  startDelayMs?: number;
};

/** Plays the professor avatar's clips for the current question, sentence by sentence. */
export default function AvatarVideoStage({ sessionId, token, text, sequence, hold = false, onFinished, announce = null,
  onVideoElement, poster = "", lead = "", startDelayMs = 0 }: Props) {
  // Read when a new question is spoken; a later change alone never makes the examiner speak again.
  const leadLine = useRef(lead);
  leadLine.current = lead;
  const [queue, setQueue] = useState<AvatarClip[]>([]);
  const [status, setStatus] = useState<"idle" | "preparing" | "speaking" | "blocked" | "error">("idle");
  const [message, setMessage] = useState("");
  const [caption, setCaption] = useState("");
  // A short clip of the examiner waiting, looped between questions. "" falls back to the still photo.
  const [idle, setIdle] = useState("");
  const video = useRef<HTMLVideoElement | null>(null);
  const request = useRef<AbortController | null>(null);
  // Speaking is finished when the clip stream has ended AND every received clip has played.
  const streamDone = useRef(false);
  const pending = useRef(0);
  const finished = useRef(true);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    onFinishedRef.current?.();
  }, []);

  const say = useCallback((words: string, before = "") => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setQueue([]); setCaption(""); setMessage(""); setStatus("preparing");
    streamDone.current = false; pending.current = 0; finished.current = false;
    void streamAvatarSpeech(sessionId, token, words, clip => {
      if (controller.signal.aborted) return;
      pending.current += 1;
      setQueue(current => [...current, clip]);
    }, controller.signal, before).then(() => {
      if (controller.signal.aborted) return;
      streamDone.current = true;
      if (pending.current === 0) { setStatus("idle"); finish(); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      streamDone.current = true;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The avatar is unavailable. The question is shown below.");
      if (pending.current === 0) finish();
    });
  }, [sessionId, token, finish]);

  useEffect(() => {
    if (!sessionId || !token) return;
    const controller = new AbortController();
    // The clip is made in the background once the avatar loads, so it may not exist on the first ask.
    const find = () => void fetchExaminerIdle(sessionId, token, controller.signal).then(url => {
      if (url) { setIdle(url); window.clearInterval(timer); }
    });
    const timer = window.setInterval(find, 20000);
    find();
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [sessionId, token]);

  useEffect(() => {
    if (!sessionId || !token || !text) return;
    // Questions are ready to play at once now, so a short pause gives the student a moment to settle.
    const timer = window.setTimeout(() => say(text, leadLine.current), startDelayMs);
    return () => { window.clearTimeout(timer); request.current?.abort(); };
  }, [sessionId, token, text, sequence, say, startDelayMs]);

  useEffect(() => {
    if (announce?.text) say(announce.text);
  // Only a new announcement id should speak; the text alone never re-triggers.
  }, [announce?.id]);

  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    video.current = element;
    onVideoElement?.(element);
  }, [onVideoElement]);

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
    pending.current = Math.max(0, pending.current - 1);
    if (pending.current === 0 && streamDone.current) finish();
    setQueue(current => {
      const rest = current.slice(1);
      if (rest.length === 0) setStatus("idle");
      return rest;
    });
  };

  const talking = status === "speaking" || status === "blocked";
  return <section className="avatar-video-stage" aria-label="Examiner">
    <div className={`avatar-video-frame${talking ? " is-talking" : ""}${status === "preparing" ? " is-preparing" : ""}`}>
      {/* Waiting or getting ready: the examiner idling on a loop, or their photo, never a blank box. */}
      {idle
        ? <video className="avatar-video-poster avatar-video-idle" src={idle} autoPlay loop muted playsInline
            aria-hidden="true" />
        : poster
          ? <img className="avatar-video-poster" src={poster} alt="" aria-hidden="true" />
          : <div className="avatar-video-placeholder" aria-hidden="true"><OralExamMark size={72} /></div>}
      <video ref={attachVideo} className="avatar-video" playsInline preload="auto" onEnded={ended} onError={ended}
        aria-describedby="avatar-video-caption" />
      {status === "preparing" && <span className="avatar-video-ring" aria-hidden="true" />}
    </div>
    <p id="avatar-video-caption" className="avatar-video-caption" aria-live="polite">
      {status === "preparing" ? "The examiner is getting ready…" : caption}
    </p>
    {status === "blocked" && <div className="avatar-video-controls">
      <button type="button" onClick={() => {
        video.current?.play().then(() => setStatus("speaking")).catch(() => setStatus("blocked"));
      }}>Play the examiner</button>
    </div>}
    {message && <p role="status" className="avatar-video-message">{message}</p>}
  </section>;
}
