import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, ImageUp, LoaderCircle, Mic, Play, Square, Trash2, Upload, X } from "lucide-react";
import ProfessorHeader from "../../components/professor/ProfessorHeader";
import { streamProfessorPreview } from "../../components/avatar/avatarService";
import type { AvatarClip } from "../../components/avatar/avatarService";
import "./professor-avatar.css";

type Avatar = {
  id: string;
  name: string;
  created: string | null;
  complete: boolean;
  active: boolean;
  mine: boolean;
};

type Overview = {
  enabled: boolean;
  ready?: boolean;
  progress?: string | null;
  build_error?: string | null;
  consent_text?: string;
  active?: (Partial<Avatar> & { other?: boolean }) | null;
  avatars?: Avatar[];
};

const SAMPLE_PASSAGE = "Thank you for coming in today. In this oral exam I will ask you a few questions about the course. "
  + "Take your time, explain your thinking in your own words, and give an example when you can. If a question is unclear, "
  + "just ask me to repeat it. There are no trick questions, and it is fine to pause and think before you answer.";
const MIN_VOICE_SECONDS = 15;
const MAX_VOICE_SECONDS = 30;

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/avatar/professor${path}`, { credentials: "include", ...init });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.detail === "string" ? data.detail : `Request failed (${response.status}).`);
  }
  return data as T;
}

function formatDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function pickAudioType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
    .find(type => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) ?? "";
}

export default function ProfessorAvatar() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState("");
  const [voice, setVoice] = useState<Blob | null>(null);
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceSeconds, setVoiceSeconds] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState("");
  const [formError, setFormError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [listError, setListError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | null>(null);
  const previewVideo = useRef<HTMLVideoElement>(null);
  const previewQueue = useRef<AvatarClip[]>([]);
  // Taking the photo with the computer's camera instead of uploading one.
  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const cameraVideo = useRef<HTMLVideoElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await api<Overview>("/avatars"));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The avatar settings could not be loaded.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // While an avatar is being prepared, check its progress every two seconds.
  const preparing = !!overview?.enabled && !!overview.active?.id && !overview.ready && !overview.build_error;
  useEffect(() => {
    if (!preparing) return;
    const id = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(id);
  }, [preparing, load]);

  useEffect(() => () => {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
  }, [photoUrl, voiceUrl]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  function stopCamera() {
    cameraStream.current?.getTracks().forEach(track => track.stop());
    cameraStream.current = null;
    setCameraOn(false);
  }

  useEffect(() => () => cameraStream.current?.getTracks().forEach(track => track.stop()), []);

  async function startCamera() {
    setCameraError(""); setFormError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser cannot use the camera here. Upload a photo instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
      });
      cameraStream.current = stream;
      setCameraOn(true);
      // The video element renders once cameraOn is true.
      window.requestAnimationFrame(() => {
        if (cameraVideo.current) {
          cameraVideo.current.srcObject = stream;
          void cameraVideo.current.play().catch(() => undefined);
        }
      });
    } catch (error) {
      setCameraError(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Camera access was blocked. Allow the camera in your browser, or upload a photo instead."
        : "No camera could be started. Upload a photo instead.");
    }
  }

  async function capturePhoto() {
    const video = cameraVideo.current;
    if (!video || video.videoWidth === 0) return;
    // Square crop from the centre, like the avatar service does, so the preview matches the result.
    const side = Math.min(video.videoWidth, video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Un-mirror: the live view is mirrored like a mirror, the saved photo is not.
    context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, side, side);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) { setCameraError("The photo could not be captured. Try again."); return; }
    stopCamera();
    if (side < 512) setFormError(`Your camera gives a small photo (${side} pixels). It will work, but an uploaded photo of at least 512 pixels looks better.`);
    choosePhoto(new File([blob], "camera-photo.jpg", { type: "image/jpeg" }));
  }

  function choosePhoto(file: File | null) {
    setFormError("");
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhoto(file);
    setPhotoUrl(file ? URL.createObjectURL(file) : "");
  }

  function setVoiceSample(blob: Blob | null, seconds: number | null) {
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    setVoice(blob);
    setVoiceSeconds(seconds);
    setVoiceUrl(blob ? URL.createObjectURL(blob) : "");
  }

  function chooseVoiceFile(file: File | null) {
    setFormError("");
    if (!file) { setVoiceSample(null, null); return; }
    const probe = new Audio(URL.createObjectURL(file));
    probe.addEventListener("loadedmetadata", () => {
      const seconds = Number.isFinite(probe.duration) ? probe.duration : null;
      URL.revokeObjectURL(probe.src);
      setVoiceSample(file, seconds);
    }, { once: true });
    probe.addEventListener("error", () => { URL.revokeObjectURL(probe.src); setVoiceSample(file, null); }, { once: true });
  }

  async function startRecording() {
    setFormError("");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setFormError("Microphone access was blocked. Allow the microphone, or upload a recording instead.");
      return;
    }
    const type = pickAudioType();
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    const started = performance.now();
    media.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
    media.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      setRecording(false);
      const seconds = (performance.now() - started) / 1000;
      setVoiceSample(new Blob(chunks, { type: media.mimeType || "audio/webm" }), seconds);
      if (seconds < MIN_VOICE_SECONDS) setFormError(`That recording is ${Math.round(seconds)} seconds. Record at least ${MIN_VOICE_SECONDS} seconds.`);
    };
    recorder.current = media;
    media.start();
    setRecording(true);
    setRecordSeconds(0);
    timer.current = window.setInterval(() => {
      const seconds = Math.floor((performance.now() - started) / 1000);
      setRecordSeconds(seconds);
      if (seconds >= MAX_VOICE_SECONDS && media.state === "recording") media.stop();
    }, 250);
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  const voiceTooShort = voiceSeconds !== null && voiceSeconds < MIN_VOICE_SECONDS;
  const canCreate = !!name.trim() && !!photo && !!voice && !voiceTooShort && consent && !step && !recording;

  async function createAvatar() {
    if (!canCreate || !photo || !voice) return;
    setFormError("");
    let id = "";
    try {
      setStep("Saving your consent");
      id = (await api<{ id: string }>("/avatars", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), consent: true }),
      })).id;
      setStep("Uploading the photo");
      await api(`/avatars/${encodeURIComponent(id)}/photo`, { method: "PUT", body: photo });
      setStep("Uploading the voice sample");
      await api(`/avatars/${encodeURIComponent(id)}/voice`, { method: "PUT", body: voice });
      setStep("Starting the avatar");
      await api(`/avatars/${encodeURIComponent(id)}/activate`, { method: "POST" });
      choosePhoto(null);
      setVoiceSample(null, null);
      setConsent(false);
      setName("");
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The avatar could not be created.");
      // Do not leave a half-made avatar (and its uploaded photo) behind.
      if (id) await api(`/avatars/${encodeURIComponent(id)}/delete`, { method: "POST" }).catch(() => undefined);
      await load();
    } finally {
      setStep("");
    }
  }

  async function activate(id: string) {
    setBusyId(id); setListError("");
    try { await api(`/avatars/${encodeURIComponent(id)}/activate`, { method: "POST" }); await load(); }
    catch (error) { setListError(error instanceof Error ? error.message : "The avatar could not be started."); }
    finally { setBusyId(""); }
  }

  async function remove(id: string) {
    setBusyId(id); setListError("");
    try { await api(`/avatars/${encodeURIComponent(id)}/delete`, { method: "POST" }); setConfirmDelete(""); await load(); }
    catch (error) { setListError(error instanceof Error ? error.message : "The avatar could not be deleted."); }
    finally { setBusyId(""); }
  }

  function playNextPreviewClip() {
    const next = previewQueue.current.shift();
    const element = previewVideo.current;
    if (!next || !element) { setPreviewing(false); return; }
    element.src = next.url;
    void element.play().catch(() => setPreviewError("Select play on the video to hear the preview."));
  }

  async function preview() {
    setPreviewError(""); setPreviewing(true);
    previewQueue.current = [];
    let started = false;
    try {
      await streamProfessorPreview(clip => {
        previewQueue.current.push(clip);
        if (!started) { started = true; playNextPreviewClip(); }
      });
      if (!started) setPreviewing(false);
    } catch (error) {
      setPreviewing(false);
      setPreviewError(error instanceof Error ? error.message : "The preview could not play.");
    }
  }

  const active = overview?.active ?? null;
  const avatars = overview?.avatars ?? [];

  return (
    <div className="professor-dashboard-page professor-avatar-page">
      <ProfessorHeader title="Exam avatar" current="avatar" />
      <main className="professor-avatar-content">
        <div className="professor-avatar-heading">
          <p className="eyebrow">PROFESSOR PORTAL</p>
          <h1>Your exam avatar</h1>
          <p>Students see and hear this avatar ask the exam questions. Make it from one photo and a short voice recording.</p>
        </div>

        {loadError && <p role="alert" className="exam-error">{loadError}</p>}
        {overview && !overview.enabled && (
          <section className="avatar-panel">
            <h2>The talking avatar is not installed on this server</h2>
            <p>Exams use the built-in examiner and typed or spoken answers. Ask the server administrator to start the avatar service.</p>
          </section>
        )}

        {overview?.enabled && <>
          <section className="avatar-panel avatar-current" aria-labelledby="avatar-current-heading">
            <h2 id="avatar-current-heading">In use for exams</h2>
            {!active ? (
              <p>No avatar is in use yet. Create one below.</p>
            ) : active.other ? (
              <p>Another professor's avatar is in use on this server right now. Starting yours replaces it for every exam.</p>
            ) : (
              <div className="avatar-current-body">
                <img src={`/api/avatar/professor/avatars/${encodeURIComponent(active.id ?? "")}/photo`}
                  alt={`Photo used for ${active.name}`} />
                <div>
                  <p className="avatar-current-name">{active.name}</p>
                  {overview.build_error ? (
                    <p role="alert" className="exam-error">{overview.build_error}</p>
                  ) : overview.ready ? (
                    <p className="avatar-state ready"><CheckCircle2 size={18} aria-hidden="true" />Ready. Exams with the talking avatar use it.</p>
                  ) : (
                    <p className="avatar-state" role="status"><LoaderCircle size={18} className="progress-spin" aria-hidden="true" />
                      {overview.progress || "Preparing"}… This can take a few minutes the first time.</p>
                  )}
                  <button type="button" className="avatar-secondary-button" onClick={() => void preview()}
                    disabled={!overview.ready || previewing}>
                    <Play size={16} aria-hidden="true" />{previewing ? "Playing preview…" : "Preview"}
                  </button>
                  {previewError && <p role="alert" className="exam-error">{previewError}</p>}
                </div>
                <video ref={previewVideo} className="avatar-preview-video" playsInline onEnded={playNextPreviewClip}
                  onError={playNextPreviewClip} hidden={!previewing} aria-label="Avatar preview" />
              </div>
            )}
          </section>

          <section className="avatar-panel" aria-labelledby="avatar-create-heading">
            <h2 id="avatar-create-heading">Create an avatar</h2>
            <ol className="avatar-steps">
              <li>
                <label htmlFor="avatar-name"><strong>Name shown to you</strong></label>
                <input id="avatar-name" type="text" value={name} maxLength={60} placeholder="Example: Dr. Rivera"
                  onChange={event => setName(event.target.value)} disabled={!!step} />
              </li>
              <li>
                <strong>Photo</strong>
                <p className="avatar-hint">Face the camera, head and shoulders, plain background, good light. JPG or PNG, at least 512 pixels.</p>
                {cameraOn ? (
                  <div className="avatar-camera">
                    <div className="avatar-camera-frame">
                      <video ref={cameraVideo} muted playsInline aria-label="Camera preview" />
                      <div className="avatar-camera-guide" aria-hidden="true" />
                    </div>
                    <p className="avatar-hint">Line your face up with the oval and look straight at the camera.</p>
                    <div className="avatar-photo-row">
                      <button type="button" className="avatar-primary-button" onClick={() => void capturePhoto()}>
                        <Camera size={16} aria-hidden="true" />Take photo
                      </button>
                      <button type="button" className="avatar-file-button" onClick={stopCamera}>
                        <X size={16} aria-hidden="true" />Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="avatar-photo-row">
                    <div className="avatar-photo-preview">
                      {photoUrl ? <img src={photoUrl} alt="Selected photo" /> : <ImageUp size={32} aria-hidden="true" />}
                    </div>
                    <button type="button" className="avatar-file-button" onClick={() => void startCamera()} disabled={!!step}>
                      <Camera size={16} aria-hidden="true" />{photo ? "Retake with camera" : "Take a photo"}
                    </button>
                    <span className="avatar-or">or</span>
                    <label className="avatar-file-button">
                      <Upload size={16} aria-hidden="true" />{photo ? "Choose a different photo" : "Upload a photo"}
                      <input type="file" accept="image/jpeg,image/png" disabled={!!step}
                        onChange={event => choosePhoto(event.target.files?.[0] ?? null)} />
                    </label>
                  </div>
                )}
                {cameraError && <p role="alert" className="exam-error">{cameraError}</p>}
              </li>
              <li>
                <strong>Voice sample ({MIN_VOICE_SECONDS}–{MAX_VOICE_SECONDS} seconds)</strong>
                <p className="avatar-hint">Record in a quiet room in your normal exam voice. You can read this:</p>
                <blockquote className="avatar-passage">{SAMPLE_PASSAGE}</blockquote>
                <div className="avatar-voice-row">
                  {recording ? (
                    <button type="button" className="avatar-record-button is-recording" onClick={stopRecording}>
                      <Square size={16} aria-hidden="true" />Stop ({recordSeconds} s)
                    </button>
                  ) : (
                    <button type="button" className="avatar-record-button" onClick={() => void startRecording()} disabled={!!step}>
                      <Mic size={16} aria-hidden="true" />{voice ? "Record again" : "Record"}
                    </button>
                  )}
                  <span className="avatar-or">or</span>
                  <label className="avatar-file-button">
                    <Upload size={16} aria-hidden="true" />Upload a recording
                    <input type="file" accept="audio/*" disabled={!!step || recording}
                      onChange={event => chooseVoiceFile(event.target.files?.[0] ?? null)} />
                  </label>
                </div>
                {voiceUrl && <div className="avatar-voice-preview">
                  <audio controls src={voiceUrl} aria-label="Your voice sample" />
                  {voiceSeconds !== null && <span className={voiceTooShort ? "avatar-warn" : ""}>{Math.round(voiceSeconds)} s
                    {voiceTooShort ? ` · record at least ${MIN_VOICE_SECONDS} s` : ""}</span>}
                </div>}
              </li>
              <li>
                <label className="avatar-consent">
                  <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={!!step} />
                  <span>{overview.consent_text}</span>
                </label>
              </li>
            </ol>
            {formError && <p role="alert" className="exam-error">{formError}</p>}
            <div className="avatar-create-actions">
              <button type="button" className="avatar-primary-button" onClick={() => void createAvatar()} disabled={!canCreate}>
                {step ? <><LoaderCircle size={16} className="progress-spin" aria-hidden="true" />{step}…</> : "Create and use this avatar"}
              </button>
              <p className="avatar-hint">One avatar is in use on this server at a time; creating one switches every exam to it.
                The photo and recording stay on the exam server, never in the database or the code repository.</p>
            </div>
          </section>

          <section className="avatar-panel" aria-labelledby="avatar-list-heading">
            <h2 id="avatar-list-heading">Your avatars</h2>
            {listError && <p role="alert" className="exam-error">{listError}</p>}
            {avatars.length === 0 ? <p>None yet.</p> : (
              <ul className="avatar-list">
                {avatars.map(item => (
                  <li key={item.id}>
                    <img src={`/api/avatar/professor/avatars/${encodeURIComponent(item.id)}/photo`} alt=""
                      onError={event => { event.currentTarget.style.visibility = "hidden"; }} />
                    <div className="avatar-list-main">
                      <strong>{item.name}</strong>
                      <span>
                        {item.created ? `Created ${formatDate(item.created)}` : ""}
                        {!item.mine ? " · made in the avatar prototype" : ""}
                      </span>
                    </div>
                    <div className="avatar-list-badges">
                      {item.active && <span className="avatar-badge in-use">In use</span>}
                      {!item.complete && <span className="avatar-badge incomplete">Incomplete</span>}
                    </div>
                    <div className="avatar-list-actions">
                      {item.complete && !item.active && (
                        <button type="button" onClick={() => void activate(item.id)} disabled={!!busyId}>
                          {busyId === item.id ? "Starting…" : "Use for exams"}
                        </button>
                      )}
                      {item.mine && (confirmDelete === item.id ? <>
                        <button type="button" className="avatar-danger" onClick={() => void remove(item.id)} disabled={!!busyId}>
                          Delete photo and voice
                        </button>
                        <button type="button" onClick={() => setConfirmDelete("")}>Keep</button>
                      </> : (
                        <button type="button" className="avatar-danger" onClick={() => setConfirmDelete(item.id)} disabled={!!busyId}>
                          <Trash2 size={15} aria-hidden="true" />Delete
                        </button>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>}
      </main>
    </div>
  );
}
