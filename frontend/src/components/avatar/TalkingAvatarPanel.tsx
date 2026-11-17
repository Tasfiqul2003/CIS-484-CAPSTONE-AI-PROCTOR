import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, Play } from "lucide-react";
import { streamProfessorPreview } from "./avatarService";
import type { AvatarClip } from "./avatarService";

type Choice = { id: string; name: string };
type Overview = {
  enabled: boolean;
  ready?: boolean;
  progress?: string | null;
  build_error?: string | null;
  active?: { id?: string | null } | null;
  selected?: Choice | null;
  other_exam_running?: boolean;
};

/** The professor's talking avatar, as students of this exam will see it, with a short preview. */
export default function TalkingAvatarPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const queue = useRef<AvatarClip[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/avatar/professor/avatars", { credentials: "include" });
      if (!response.ok) throw new Error("The talking avatar status is unavailable.");
      setOverview(await response.json() as Overview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The talking avatar status is unavailable.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const selected = overview?.selected ?? null;
  const loaded = !!selected && overview?.active?.id === selected.id;
  const preparing = loaded && !overview?.ready && !overview?.build_error;
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [preparing, load]);

  async function loadNow() {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/avatar/professor/avatars/${encodeURIComponent(selected.id)}/activate`,
        { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("The avatar could not be loaded.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The avatar could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  function playNext() {
    const next = queue.current.shift();
    if (!next || !video.current) { setPlaying(false); return; }
    video.current.src = next.url;
    void video.current.play().catch(() => setError("Select play on the video to hear the preview."));
  }

  async function preview() {
    setError(""); setPlaying(true); queue.current = [];
    let started = false;
    try {
      await streamProfessorPreview(clip => {
        queue.current.push(clip);
        if (!started) { started = true; playNext(); }
      });
      if (!started) setPlaying(false);
    } catch (err) {
      setPlaying(false);
      setError(err instanceof Error ? err.message : "The preview could not play.");
    }
  }

  if (!overview && !error) return <p role="status">Loading your talking avatar…</p>;
  if (overview && !overview.enabled) {
    return <p>The talking avatar is not installed on this server, so this exam uses the built-in examiner below.</p>;
  }
  return <div className="talking-avatar-panel">
    {selected ? <div className="talking-avatar-body">
      <img src={`/api/avatar/professor/avatars/${encodeURIComponent(selected.id)}/photo`} alt={`Photo used for ${selected.name}`} />
      <div>
        <p className="talking-avatar-name">{selected.name}</p>
        <p className="avatar-help">Students taking this exam see and hear this avatar ask each question.</p>
        {!loaded ? <>
          <p>Loads automatically when a student starts the exam.</p>
          <button type="button" onClick={() => void loadNow()} disabled={busy || !!overview?.other_exam_running}>
            <Play size={16} aria-hidden="true" />{busy ? "Loading…" : "Load now to preview"}
          </button>
          {overview?.other_exam_running && <p className="avatar-help">Another professor's exam is running, so previews wait until it ends.</p>}
        </> : overview?.build_error ? <p role="alert" className="avatar-error">{overview.build_error}</p>
          : overview?.ready ? <>
            <p className="talking-avatar-ready"><CheckCircle2 size={16} aria-hidden="true" />Loaded and ready.</p>
            <button type="button" onClick={() => void preview()} disabled={playing}>
              <Play size={16} aria-hidden="true" />{playing ? "Playing preview…" : "Preview"}
            </button>
          </> : <p role="status"><LoaderCircle size={16} className="progress-spin" aria-hidden="true" />{overview?.progress || "Preparing"}…</p>}
      </div>
      <video ref={video} className="talking-avatar-video" playsInline onEnded={playNext} onError={playNext}
        hidden={!playing} aria-label="Avatar preview" />
    </div> : <p>You have not chosen a talking avatar yet.</p>}
    {error && <p role="alert" className="avatar-error">{error}</p>}
    <p><a href="/professor/avatar">{selected ? "Change or create an avatar" : "Create your avatar"}</a> on the Avatar page.</p>
  </div>;
}
