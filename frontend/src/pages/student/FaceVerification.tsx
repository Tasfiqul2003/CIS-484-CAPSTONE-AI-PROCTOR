import { useEffect, useRef, useState } from "react";
import OralExamMark from "../../components/brand/OralExamMark";

type FaceCheckResult = {
  matched: boolean;
  allowed: boolean;
  attempt: number;
  max_attempts: number;
  review_required: boolean;
};

const MIN_RECORDING_SECONDS = 3;
const MAX_RECORDING_SECONDS = 6;

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

  const studentId = sessionStorage.getItem("oralexam_student_id");
  const studentName = sessionStorage.getItem("oralexam_student_name");
  const studentEid = sessionStorage.getItem("oralexam_student_eid") || "";

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
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : `Photo check failed (${response.status}).`,
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
    setError("");
    setResult(null);
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
    if (!result?.allowed || !studentId || !studentEid) {
      window.location.href = "/student/verification";
      return;
    }

    // The backend independently enforces the recorded match/override state.
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
      </header>

      <main id="main-content" className="verification-content" aria-labelledby="photo-check-heading">
        <div className="verification-card">
          <p className="eyebrow">STEP 2 OF 3</p>
          <h1 id="photo-check-heading">Photo check</h1>
          <p className="verification-description">
            {studentName ? `Welcome, ${studentName}. ` : ""}
            Look at the camera for 3–6 seconds.
          </p>
          <p className="photo-check-hint">No need to hold your JACard.</p>

          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="camera-live-preview"
            aria-label="Live camera recording preview"
          />

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

          {!cameraActive && !cameraStarting && !processing && !result?.allowed
            && !result?.review_required && (
            <button
              type="button"
              className="continue-button"
              onClick={() => void startRecording()}
            >
              Start Recording
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

          {result?.allowed && (
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
          </details>

          <a className="back-button student-home-link" href="/">
            Home
          </a>
        </div>
      </main>
    </div>
  );
}
