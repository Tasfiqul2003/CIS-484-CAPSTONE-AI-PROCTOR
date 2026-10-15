
import { useEffect, useRef, useState } from "react";

type Stage =
  | "ready"
  | "starting"
  | "recording"
  | "finishing"
  | "review"
  | "verifying"
  | "verified";

type Challenge = {
  challenge_id: string;
  code: string;
  expires_in_seconds: number;
};

type VerificationResponse = {
  verified: boolean;
  message?: string;
};

const MAX_RECORDING_MS = 45_000;

const CHALLENGE_URL = "/api/identity/challenge";
const VERIFY_URL = "/api/identity/verify";

export default function FaceVerification() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordedVideoRef = useRef<Blob | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const mountedRef = useRef(true);

  const [stage, setStage] = useState<Stage>("ready");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(
    null
  );
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  // ----------------------------------
  // Stop Camera and Microphone
  // ----------------------------------

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });

    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  // ----------------------------------
  // Clear Recording Timer
  // ----------------------------------

  function clearTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  // ----------------------------------
  // Discard Browser Recording
  // ----------------------------------

  function discardLocalRecording() {
    recordedVideoRef.current = null;
    chunksRef.current = [];

    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }

    setVideoUrl(null);
  }

  // ----------------------------------
  // Clean Up When Page Closes
  // ----------------------------------

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearTimer();

      const recorder = recorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.stop();
      }

      stopCamera();

      recordedVideoRef.current = null;
      chunksRef.current = [];

      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
  }, []);

  // ----------------------------------
  // Finish Recording
  // ----------------------------------

  function finishRecording() {
    clearTimer();

    const recorder = recorderRef.current;

    if (recorder && recorder.state === "recording") {
      setStage("finishing");
      recorder.stop();
    }
  }

  // ----------------------------------
  // Generate Code and Start Recording
  // ----------------------------------

  async function startRecording() {
    if (
      stage === "starting" ||
      stage === "recording" ||
      stage === "verifying"
    ) {
      return;
    }

    setError("");
    setStatusMessage("");
    setChallenge(null);
    setSubmitted(false);
    discardLocalRecording();

    setStage("starting");

    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error(
          "This browser does not support camera recording."
        );
      }

      // Step 1: Request random verification code
      const challengeResponse = await fetch(CHALLENGE_URL, {
        method: "POST",
        cache: "no-store",
      });

      if (!challengeResponse.ok) {
        throw new Error(
          "Unable to generate a verification code."
        );
      }

      const newChallenge: Challenge =
        await challengeResponse.json();

      if (
        !newChallenge.challenge_id ||
        !/^\d{6}$/.test(newChallenge.code)
      ) {
        throw new Error(
          "The server returned an invalid verification code."
        );
      }

      if (!mountedRef.current) return;

      setChallenge(newChallenge);

      // Step 2: Request camera and microphone
      const stream =
        await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      // Step 3: Show live camera preview
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      // Step 4: Choose supported video format
      const supportedMimeType = [
        "video/webm;codecs=vp8,opus",
        "video/webm",
        "video/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));

      const recorder = new MediaRecorder(
        stream,
        supportedMimeType
          ? { mimeType: supportedMimeType }
          : undefined
      );

      recorderRef.current = recorder;
      chunksRef.current = [];

      // Step 5: Collect video chunks
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      // Step 6: Prepare recording for review
      recorder.onstop = () => {
        clearTimer();
        stopCamera();

        if (!mountedRef.current) return;

        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });

        chunksRef.current = [];

        if (blob.size === 0) {
          setError(
            "No video was recorded. Please try again."
          );
          setStage("ready");
          return;
        }

        recordedVideoRef.current = blob;

        const localUrl = URL.createObjectURL(blob);

        videoUrlRef.current = localUrl;
        setVideoUrl(localUrl);
        setStage("review");
      };

      recorder.onerror = () => {
        clearTimer();
        recorder.onstop = null;

        if (recorder.state !== "inactive") {
          recorder.stop();
        }

        stopCamera();
        chunksRef.current = [];
        setError(
          "A recording error occurred. Please try again."
        );
        setStage("ready");
      };

      // Step 7: Start recording
      recorder.start(1000);
      setStage("recording");

      // Automatically stop after 45 seconds
      timerRef.current = setTimeout(() => {
        finishRecording();
      }, MAX_RECORDING_MS);

    } catch (err) {
      stopCamera();
      setChallenge(null);
      setStage("ready");

      setError(
        err instanceof Error
          ? err.message
          : "Unable to start verification."
      );
    }
  }

  // ----------------------------------
  // Submit Recording for Verification
  // ----------------------------------

  async function verifyRecording() {
    const recording = recordedVideoRef.current;

    if (!recording) {
      setError("No recording is available.");
      return;
    }

    if (!challenge) {
      setError(
        "No verification challenge found. Please record again."
      );
      return;
    }

    if (submitted) {
      setError(
        "This verification attempt was already submitted. Please record again."
      );
      return;
    }

    // Challenges are one-time-use.
    setSubmitted(true);
    setStage("verifying");
    setError("");
    setStatusMessage("");

    const formData = new FormData();

    // Include one-time challenge ID
    formData.append(
      "challenge_id",
      challenge.challenge_id
    );

    const extension = recording.type.includes("mp4")
      ? "mp4"
      : "webm";

    formData.append(
      "video",
      recording,
      `jacard-verification.${extension}`
    );

    try {
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const details = await response.json().catch(() => null);

        throw new Error(
          typeof details?.detail === "string"
            ? details.detail
            : `Verification request failed (${response.status}).`
        );
      }

      const result: VerificationResponse =
        await response.json();

      if (result.verified === true) {
        // Only a successful backend decision can verify.
        discardLocalRecording();
        setChallenge(null);
        setStage("verified");
      } else {
        setStatusMessage(
          result.message ||
          "Recording received, but identity was not verified."
        );
        setStage("review");
      }

    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not connect to the verification service."
      );
      setStage("review");
    }
  }

  // ----------------------------------
  // Page Interface
  // ----------------------------------

  return (
    <div className="face-page">
      <h1>JACard Face Verification</h1>

      <p>
        Before beginning your oral examination, please
        verify your identity using your JMU JACard.
      </p>

      {stage !== "verified" && (
        <>
          <h2>Verification Instructions</h2>

          <ol>
            <li>Sit in a well-lit location.</li>
            <li>Keep your face clearly visible.</li>
            <li>Hold your JACard beside your face.</li>
            <li>
              Read the six-digit verification code aloud.
            </li>
            <li>
              Keep your JACard visible while speaking.
            </li>
            <li>
              Finish the recording and submit it.
            </li>
          </ol>
        </>
      )}

      {/* Random Verification Challenge */}

      {challenge && stage !== "verified" && (
        <div
          className="verification-challenge"
          style={{
            padding: "20px",
            margin: "20px 0",
            border: "2px solid #4f46e5",
            borderRadius: "12px",
            textAlign: "center",
          }}
        >
          <h2>Your Verification Code</h2>

          <h1
            style={{
              fontSize: "42px",
              letterSpacing: "8px",
            }}
          >
            {challenge.code}
          </h1>

          <p>
            Hold your JACard beside your face and
            read this code aloud.
          </p>

          <p>
            Code expires in 5 minutes.
          </p>
        </div>
      )}

      {/* Camera Preview */}

      <div className="camera-preview">
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{
            display:
              stage === "starting" ||
              stage === "recording"
                ? "block"
                : "none",
            width: "100%",
            maxWidth: 640,
          }}
        />

        {stage === "ready" && (
          <p>Camera is currently off.</p>
        )}

        {stage === "starting" && (
          <p>
            Preparing verification code and camera...
          </p>
        )}

        {stage === "recording" && (
          <p role="status">
            🔴 Recording — Hold your JACard beside
            your face and read the code aloud.
            Maximum duration: 45 seconds.
          </p>
        )}

        {stage === "finishing" && (
          <p>Preparing your recorded video...</p>
        )}

        {videoUrl && stage !== "verified" && (
          <video
            src={videoUrl}
            controls
            playsInline
            style={{
              width: "100%",
              maxWidth: 640,
            }}
          />
        )}
      </div>

      {/* Errors and Status */}

      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      {statusMessage && (
        <p role="status">
          {statusMessage}
        </p>
      )}

      {/* Start Recording */}

      {stage === "ready" && (
        <button
          type="button"
          onClick={startRecording}
        >
          Enable Camera & Start Recording
        </button>
      )}

      {/* Stop Recording */}

      {stage === "recording" && (
        <button
          type="button"
          onClick={finishRecording}
        >
          Finish Recording
        </button>
      )}

      {/* Review and Submit Recording */}

      {stage === "review" && (
        <div>
          <h2>Review Your Recording</h2>

          <p>
            Your video is temporarily held in
            browser memory for review.
          </p>

          {!submitted && (
            <button
              type="button"
              onClick={verifyRecording}
            >
              Submit for Verification
            </button>
          )}

          {submitted && (
            <p>
              This challenge has already been submitted.
              Start a new recording to try again.
            </p>
          )}

          <button
            type="button"
            onClick={startRecording}
          >
            Record Again
          </button>

          <button
            type="button"
            onClick={() => {
              discardLocalRecording();
              setChallenge(null);
              setSubmitted(false);
              setError("");
              setStatusMessage("");
              setStage("ready");
            }}
          >
            Discard Recording
          </button>
        </div>
      )}

      {/* Backend Verification */}

      {stage === "verifying" && (
        <p role="status">
          Processing your verification request.
          Please wait...
        </p>
      )}

      {/* Verified Status */}

      {stage === "verified" && (
        <div>
          <h2>Identity Verified</h2>

          <p>
            Verification was successful.
            The browser recording has been discarded.
          </p>

          <a href="/student/exams">
            Continue to My Exams
          </a>
        </div>
      )}
    </div>
  );
}
