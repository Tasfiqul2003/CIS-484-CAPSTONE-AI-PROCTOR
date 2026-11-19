import PortalThemeToggle from "../../components/theme/PortalThemeToggle";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CameraOff } from "lucide-react";
import OralExamMark from "../../components/brand/OralExamMark";
import { DEVELOPER_EIDS } from "./studentIdentity";

type FaceCheckResult = {
  matched: boolean;
  allowed: boolean;
  attempt: number;
  max_attempts: number;
  review_required: boolean;
};

const MIN_RECORDING_SECONDS = 3;
const MAX_RECORDING_SECONDS = 6;
const DEVELOPER_BYPASS_KEY = "oralexam_developer_face_bypass";
const DEVELOPER_BYPASS_ENDPOINT = "/api/exam/student/developer-face-bypass";
type DeveloperBypassResult = {
  student: { id: string; name: string; eid: string };
  expires_at: string;
};

async function extractFrames(recording: Blob): Promise<Blob[]> {
  const objectUrl = URL.createObjectURL(recording);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("The camera recording could not be read. Please try again.")),
        { once: true },
      );
      video.src = objectUrl;
      video.load();
    });

    if (!Number.isFinite(video.duration) || video.duration < MIN_RECORDING_SECONDS) {
      throw new Error("Record for at least three seconds before stopping.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) {
      throw new Error("The camera recording did not contain usable frames.");
    }

    const frames: Blob[] = [];
    for (const fraction of [0.2, 0.5, 0.8]) {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
        video.addEventListener(
          "error",
          () => reject(new Error("The camera recording could not be read. Please try again.")),
          { once: true },
        );
        video.currentTime = Math.min(video.duration - 0.05, video.duration * fraction);
      });

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.85),
      );
      if (!frame) throw new Error("Unable to prepare a camera frame. Please try again.");
      frames.push(frame);
    }

    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

export default function FaceVerification() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const requestIdRef = useRef(0);
  const cameraStartingRef = useRef(false);

  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [result, setResult] = useState<FaceCheckResult | null>(null);
  const [error, setError] = useState("");
  // The last camera frame stays on screen after recording instead of the box going black.
  const [frozenFrame, setFrozenFrame] = useState("");

  const studentId = sessionStorage.getItem("oralexam_student_id");
  const studentName = sessionStorage.getItem("oralexam_student_name");
  const studentEid = sessionStorage.getItem("oralexam_student_eid") || "";
  const [developerEids, setDeveloperEids] = useState<string[]>([]);
  const [bypassEid, setBypassEid] = useState<string>(DEVELOPER_EIDS.some(eid => eid === studentEid) ? studentEid : "");
  const [bypassBusy, setBypassBusy] = useState(false);
  const [bypassError, setBypassError] = useState("");
  const [bypassResult, setBypassResult] = useState<DeveloperBypassResult | null>(null);
  const [bypassExpired, setBypassExpired] = useState(false);
  const bypassBusyRef = useRef(false);
  const bypassControllerRef = useRef<AbortController | null>(null);
  const bypassGenerationRef = useRef(0);
  const captureBusy = cameraStarting || cameraActive || processing;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    void (async () => {
      try {
        const response = await fetch(DEVELOPER_BYPASS_ENDPOINT, { credentials: "include", signal: controller.signal });
        const data = await response.json();
        if (controller.signal.aborted || !response.ok || data.enabled !== true || !Array.isArray(data.allowed_eids)) return;
        setDeveloperEids(DEVELOPER_EIDS.filter(eid => data.allowed_eids.includes(eid)));
      } catch {
        // An unavailable or disabled server capability never enables a local bypass.
      } finally {
        window.clearTimeout(timer);
      }
    })();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      bypassGenerationRef.current += 1;
      bypassControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!bypassResult) return;
    const timer = window.setTimeout(() => setBypassExpired(true), Math.max(0, Date.parse(bypassResult.expires_at) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [bypassResult]);

  async function bypassPhotoCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const eid = bypassEid.trim().toLowerCase();
    if (bypassBusyRef.current || cameraStartingRef.current || captureBusy || !developerEids.includes(eid)) return;
    bypassBusyRef.current = true;
    setBypassBusy(true);
    setBypassError("");
    const generation = ++bypassGenerationRef.current;
    const controller = new AbortController();
    bypassControllerRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(DEVELOPER_BYPASS_ENDPOINT, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eid }),
      });
      const data = await response.json().catch(() => ({}));
      if (generation !== bypassGenerationRef.current) return;
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Developer photo bypass was not authorized.");
      const student = data.student;
      const expiry = typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
      if (controller.signal.aborted || data.allowed !== true || data.matched !== false || data.developer_bypass !== true
        || data.identity_check_completed !== false || data.review_required !== true
        || !student || typeof student.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(student.id)
        || typeof student.name !== "string" || !student.name.trim() || student.eid !== eid
        || !developerEids.includes(student.eid) || !Number.isFinite(expiry) || expiry <= Date.now()
        || expiry - Date.now() > 16 * 60 * 1000) {
        throw new Error("The server did not return a valid, current developer photo bypass.");
      }
      // This is a navigation hint. Only the server's signed HttpOnly cookie authorizes access.
      sessionStorage.removeItem("oralexam_face_check_passed");
      sessionStorage.removeItem("oralexam_exam_session_id");
      sessionStorage.removeItem("oralexam_exam_session_token");
      sessionStorage.removeItem("oralexam_developer_demo");
      sessionStorage.setItem("oralexam_student_id", student.id);
      sessionStorage.setItem("oralexam_student_name", student.name);
      sessionStorage.setItem("oralexam_student_eid", student.eid);
      sessionStorage.setItem(DEVELOPER_BYPASS_KEY, JSON.stringify({ student_id: student.id, eid: student.eid, expires_at: data.expires_at }));
      setResult(null);
      setBypassExpired(false);
      setBypassResult({ student, expires_at: data.expires_at });
    } catch (failure) {
      if (generation === bypassGenerationRef.current) {
        setBypassError(controller.signal.aborted ? "Developer photo bypass timed out. Please try again."
          : failure instanceof Error ? failure.message : "Developer photo bypass was not authorized.");
      }
    } finally {
      window.clearTimeout(timer);
      if (generation === bypassGenerationRef.current) {
        bypassBusyRef.current = false;
        bypassControllerRef.current = null;
        setBypassBusy(false);
      }
    }
  }

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!cameraActive) return;
    if (elapsedSeconds >= MAX_RECORDING_SECONDS) {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      return;
    }

    const timer = window.setTimeout(
      () => setElapsedSeconds((seconds) => seconds + 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cameraActive, elapsedSeconds]);

  async function submitRecording(recording: Blob, requestId: number) {
    try {
      const frames = await extractFrames(recording);
      if (requestId !== requestIdRef.current) return;

      const formData = new FormData();
      formData.append("eid", studentEid);
      frames.forEach((frame, index) => {
        formData.append("frames", frame, `frame-${index + 1}.jpg`);
      });

      const response = await fetch("/api/exam/student/face-check", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof data.detail === "string" ? data.detail : "";
        throw new Error(
          detail.includes("exactly one")
            ? "Make sure only your face is in view, with no one else in the camera, and try again."
            : detail || `Photo check failed (${response.status}).`,
        );
      }

      if (requestId === requestIdRef.current) setResult(data as FaceCheckResult);
    } catch (submitError) {
      if (requestId === requestIdRef.current) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Unable to check the camera frames.",
        );
      }
    } finally {
      if (requestId === requestIdRef.current) setProcessing(false);
    }
  }

  async function startRecording() {
    if (cameraStartingRef.current || bypassBusyRef.current || captureBusy) return;
    setError("");
    setResult(null);
    setFrozenFrame("");
    if (cameraStartingRef.current) return;

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError("Camera access requires HTTPS (or localhost) and a supported browser.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("This browser does not support short camera recordings.");
      return;
    }

    const requestId = ++requestIdRef.current;
    cameraStartingRef.current = true;
    setCameraStarting(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: false,
      });
      if (requestId !== requestIdRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      if (!videoRef.current) throw new Error("The camera preview is unavailable.");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const mimeType = [
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const preview = videoRef.current;
        if (preview && preview.videoWidth > 0) {
          const still = document.createElement("canvas");
          still.width = preview.videoWidth;
          still.height = preview.videoHeight;
          still.getContext("2d")?.drawImage(preview, 0, 0);
          setFrozenFrame(still.toDataURL("image/jpeg", 0.85));
        }
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        if (requestId !== requestIdRef.current) return;

        setCameraActive(false);
        setProcessing(true);
        const recording = new Blob(chunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });
        chunksRef.current = [];
        void submitRecording(recording, requestId);
      };
      recorder.onerror = () => {
        requestIdRef.current += 1;
        setCameraActive(false);
        setProcessing(false);
        setError("Camera recording failed. Check camera permissions and try again.");
        if (recorder.state === "recording") recorder.stop();
      };

      recorder.start();
      setElapsedSeconds(0);
      setCameraActive(true);
    } catch (cameraError) {
      if (requestId !== requestIdRef.current) return;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;

      if (cameraError instanceof DOMException && cameraError.name === "NotAllowedError") {
        setError("Camera permission was denied. Allow camera access in your browser and try again.");
      } else if (cameraError instanceof DOMException && cameraError.name === "NotFoundError") {
        setError("No camera was found. Connect a camera and try again.");
      } else {
        setError(
          cameraError instanceof Error
            ? cameraError.message
            : "Unable to start the camera. Check browser permissions and try again.",
        );
      }
    } finally {
      if (requestId === requestIdRef.current) {
        cameraStartingRef.current = false;
        setCameraStarting(false);
      }
    }
  }

  function stopRecording() {
    if (elapsedSeconds < MIN_RECORDING_SECONDS) return;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  function continueToPortal() {
    if (bypassResult) {
      if (bypassExpired || Date.parse(bypassResult.expires_at) <= Date.now()
        || bypassResult.student.id !== studentId || bypassResult.student.eid !== studentEid) {
        setBypassExpired(true);
        sessionStorage.removeItem(DEVELOPER_BYPASS_KEY);
        return;
      }
      window.location.href = "/student/exams";
      return;
    }
    if (!result?.allowed || !studentId || !studentEid) {
      window.location.href = "/student/verification";
      return;
    }

    // The backend independently enforces the recent recorded match.
    sessionStorage.removeItem(DEVELOPER_BYPASS_KEY);
    sessionStorage.setItem("oralexam_face_check_passed", "true");
    window.location.href = "/student/exams";
  }

  if (!studentId || !studentEid) {
    return (
      <main className="face-page">
        <a className="student-skip-link" href="#main-content">Skip to content</a>
        <h1 id="main-content" tabIndex={-1}>JACard check required</h1>
        <p>Start with your JACard.</p>
        <a href="/student/verification">Start Verification</a>
      </main>
    );
  }

  return (
    <div className="face-page">
      <a className="student-skip-link" href="#main-content">Skip to content</a>
      <header className="simple-header">
        <a className="logo" href="/" aria-label="OralExam AI home">
          <span className="logo-icon">
            <OralExamMark size={34} />
          </span>
          <span>OralExam AI</span>
        </a>
        <PortalThemeToggle />
      </header>

      <main id="main-content" className="verification-content" aria-labelledby="photo-check-heading">
        <div className="verification-card">
          <p className="eyebrow">STEP 2 OF 3</p>
          <h1 id="photo-check-heading">Photo check</h1>
          <p className="verification-description">
            {studentName ? `Welcome, ${studentName}. ` : ""}
            {bypassResult ? "Developer photo bypass selected." : "Look at the camera for 3–6 seconds."}
          </p>
          <p className="photo-check-hint">No need to hold your JACard.</p>

          <div className="camera-frame">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="camera-live-preview"
              aria-label="Live camera recording preview"
            />
            {frozenFrame && !cameraActive && (
              <img className="camera-frozen-frame" src={frozenFrame} alt="Last camera frame from your photo check" />
            )}
            {!frozenFrame && !cameraActive && (
              <div className="camera-off-overlay" aria-hidden="true">
                <CameraOff size={44} />
                <span>{cameraStarting ? "Turning on your camera…" : "Camera is off"}</span>
              </div>
            )}
          </div>
          {!cameraActive && !cameraStarting && !processing && !result && !frozenFrame && (
            <p className="camera-start-prompt">Select <strong>Start camera</strong> below. Look straight at the camera with only your face in view.</p>
          )}

          {cameraActive && (
            <>
              <p className="camera-status" role="status" aria-live="polite">
                Camera recording is active. You may stop after 3 seconds.
              </p>
              <p className="camera-timer" aria-hidden="true">
                {elapsedSeconds} / {MAX_RECORDING_SECONDS} seconds
              </p>
              <button
                type="button"
                className="continue-button"
                onClick={stopRecording}
                disabled={elapsedSeconds < MIN_RECORDING_SECONDS}
              >
                End Recording
              </button>
            </>
          )}

          {!cameraActive && !cameraStarting && !processing && !result?.allowed && !bypassResult
            && !result?.review_required && (
            <button
              type="button"
              className="continue-button"
              disabled={bypassBusy}
              onClick={() => void startRecording()}
            >
              {result || error ? "Try again" : "Start camera"}
            </button>
          )}

          {cameraStarting && <p role="status">Waiting for camera access…</p>}
          {processing && <p role="status">Checking the captured frames…</p>}
          {error && <p role="alert">{error}</p>}

          {result && (
            <div role={result.allowed ? "status" : "alert"}>
              {result.matched ? (
                <p>Photo match found. You may continue to your exams.</p>
              ) : result.review_required ? (
                <p>
                  No match after three attempts. Exam access remains blocked.
                  Contact your professor for help before trying again.
                </p>
              ) : (
                <p>
                  No match on attempt {result.attempt} of {result.max_attempts}.
                  Please try recording again.
                </p>
              )}
            </div>
          )}

          {bypassResult && (
            <div role="status">
              <p>Developer photo bypass accepted for {bypassResult.student.eid}. No photo comparison was performed. Identity remains unverified and requires professor review.</p>
              <p>Exam recording requirements and AI settings still apply.</p>
              {bypassExpired && <p role="alert">This developer photo bypass has expired. Request a new bypass below.</p>}
            </div>
          )}

          {(result?.allowed || (bypassResult && !bypassExpired)) && (
            <button
              type="button"
              className="continue-button"
              onClick={continueToPortal}
            >
              Continue to Exam Portal →
            </button>
          )}

          <p className="photo-check-hint">
            Three still images are compared with the roster photo; the clip is not saved.
          </p>
          <details className="photo-check-details">
            <summary>About this check</summary>
            <p>
              This experimental comparison does not prove liveness or verify that a physical JACard is authentic.
            </p>
            {developerEids.length > 0 && (
              <section aria-labelledby="developer-photo-bypass-heading">
                <h2 id="developer-photo-bypass-heading"><span className="eyebrow">Developer mode</span></h2>
                <p>For the listed synthetic accounts only. This skips the photo comparison; it does not verify identity. Your professor will see that identity is unverified and requires review.</p>
                <form onSubmit={event => void bypassPhotoCheck(event)}>
                  <label htmlFor="developer-photo-bypass-eid">Bypass</label>
                  <input id="developer-photo-bypass-eid" list="developer-photo-bypass-eids" type="text"
                    autoComplete="off" spellCheck={false} value={bypassEid} disabled={captureBusy || bypassBusy}
                    aria-describedby="developer-photo-bypass-help"
                    onChange={event => {
                      setBypassEid(event.target.value);
                      setBypassError("");
                      if (bypassResult) {
                        setBypassResult(null);
                        setBypassExpired(false);
                        sessionStorage.removeItem(DEVELOPER_BYPASS_KEY);
                      }
                    }} />
                  <datalist id="developer-photo-bypass-eids">
                    {developerEids.map(eid => <option key={eid} value={eid} />)}
                  </datalist>
                  <p id="developer-photo-bypass-help">Enter a demo student account recording and AI settings still apply.</p>
                  <button type="submit" className="continue-button"
                    disabled={captureBusy || bypassBusy || !developerEids.includes(bypassEid.trim().toLowerCase())}>
                    Bypass photo check
                  </button>
                </form>
                {bypassBusy && <p role="status">Requesting developer photo bypass…</p>}
                {bypassError && <p role="alert">{bypassError}</p>}
              </section>
            )}
          </details>

          <div className="verification-secondary-actions">
            <a className="back-button student-home-link" href="/">Home</a>
          </div>
        </div>
      </main>
    </div>
  );
}
