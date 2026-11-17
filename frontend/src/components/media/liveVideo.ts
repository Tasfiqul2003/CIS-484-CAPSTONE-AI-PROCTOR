export type LiveVideoState = "waiting" | "connecting" | "connected" | "reconnecting" | "ended" | "unavailable";
export type LiveVideoOptions = {
  sessionId: string;
  token?: string;
  role: "student" | "professor";
  stream?: MediaStream;
  onState: (state: LiveVideoState, message: string) => void;
  onStream?: (stream: MediaStream | null) => void;
};

type Signal = { sequence: number; kind: "offer" | "answer" | "candidate"; payload: string };
type Poll = { room_id: string; epoch: number; peer_present: boolean; signals: Signal[]; cursor: number };

/** Reuses an existing assessed stream; never acquires or stops device tracks. */
export function createLiveVideo(options: LiveVideoOptions): { stop: () => void } {
  const peerId = crypto.randomUUID();
  const path = `/api/exam/sessions/${encodeURIComponent(options.sessionId)}/live-video`;
  const headers: Record<string, string> = options.token ? { Authorization: `Bearer ${options.token}` } : {};
  let stopped = false;
  let epoch = 0;
  let roomId: string | null = null;
  let cursor = 0;
  let peer: RTCPeerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingCandidates: RTCIceCandidateInit[] = [];
  let lastFrameCount = -1;
  let lastFrameAt = performance.now();
  let disconnectedAt = 0;
  let connectedAt = 0;
  let negotiationAt = 0;
  const requests = new Set<AbortController>();

  function state(value: LiveVideoState, message: string) {
    if (!stopped) options.onState(value, message);
  }
  function closePeer() {
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.ontrack = null;
      peer.close();
      peer = null;
    }
    pendingCandidates = [];
    disconnectedAt = 0;
    connectedAt = 0;
    lastFrameCount = -1;
    lastFrameAt = performance.now();
    options.onStream?.(null);
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const request of requests) request.abort();
    requests.clear();
    closePeer();
    options.stream?.getTracks().forEach(track => track.removeEventListener("ended", trackEnded));
    // Best effort lease release; server expires it independently within 15 seconds.
    if (epoch > 0 && roomId) void fetch(path, {
      method: "POST", credentials: "include", keepalive: true,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id: peerId, room_id: roomId, epoch, kind: "leave", payload: "" }),
    }).catch(() => undefined);
  }
  function fail(message: string) {
    state("unavailable", message);
    stop();
  }
  function trackEnded() {
    state("ended", "The camera or microphone stream ended. Live viewing has stopped.");
    stop();
  }
  async function request(url: string, init?: RequestInit) {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        ...init, credentials: "include", cache: "no-store", signal: controller.signal,
        headers: { ...headers, ...init?.headers },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(typeof data.detail === "string" ? data.detail : "Live viewing is unavailable.");
        if (response.status === 410) error.name = "AttemptEnded";
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  async function signal(kind: string, payload: unknown, signalEpoch = epoch, signalRoom = roomId) {
    if (stopped || signalEpoch !== epoch || signalRoom !== roomId || !signalRoom) return;
    await request(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ peer_id: peerId, room_id: signalRoom, epoch: signalEpoch, kind, payload: JSON.stringify(payload) }),
    });
  }
  function makePeer() {
    const connection = new RTCPeerConnection({ iceServers: [] });
    const signalEpoch = epoch;
    const signalRoom = roomId;
    peer = connection;
    negotiationAt = performance.now();
    connection.onicecandidate = event => {
      if (event.candidate) void signal("candidate", event.candidate.toJSON(), signalEpoch, signalRoom).catch(() => {
        if (!stopped && signalEpoch === epoch && signalRoom === roomId) fail("The live connection could not be negotiated. Retry live viewing.");
      });
    };
    connection.onconnectionstatechange = () => {
      if (peer !== connection || stopped) return;
      if (connection.connectionState === "connected") {
        connectedAt = performance.now();
        disconnectedAt = 0;
        if (options.role === "student") state("connected", "Your professor's live connection is active.");
      } else if (connection.connectionState === "disconnected") {
        if (!disconnectedAt) disconnectedAt = performance.now();
        state("reconnecting", "The live connection was interrupted. Recording continues separately.");
      } else if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        fail("The live connection ended. Retry live viewing; the assessed recording is separate.");
      }
    };
    connection.ontrack = event => {
      if (peer === connection && !stopped && event.streams[0]) options.onStream?.(event.streams[0]);
    };
    if (options.role === "student") options.stream?.getTracks().forEach(track => connection.addTrack(track, options.stream!));
    state("connecting", "Connecting the authorized live view…");
    return connection;
  }
  async function applyCandidates(connection: RTCPeerConnection) {
    const queued = pendingCandidates;
    pendingCandidates = [];
    for (const candidate of queued) await connection.addIceCandidate(candidate);
  }
  async function checkFreshFrames() {
    const connection = peer;
    if (!connection || stopped) return;
    const now = performance.now();
    if (!connectedAt && connection.connectionState !== "connected" && now - negotiationAt > 15000) {
      fail("Live video negotiation exceeded fifteen seconds. Retry live viewing.");
      return;
    }
    if (disconnectedAt && now - disconnectedAt > 8000) {
      fail("Live viewing did not reconnect within eight seconds. Retry live viewing.");
      return;
    }
    if (options.role !== "professor" || connection.connectionState !== "connected") return;
    const stats = await connection.getStats();
    if (stopped || peer !== connection) return;
    let decoded: number | undefined;
    stats.forEach(report => {
      if (report.type === "inbound-rtp" && (report.kind === "video" || report.mediaType === "video")
          && typeof report.framesDecoded === "number") decoded = report.framesDecoded;
    });
    if (decoded !== undefined && decoded > 0 && decoded > lastFrameCount) {
      lastFrameCount = decoded;
      lastFrameAt = now;
      state("connected", "Live video connected.");
    } else if (now - lastFrameAt > 6000) {
      state("reconnecting", "No fresh video frames are arriving. The picture is hidden until video resumes.");
      if (now - lastFrameAt > 12000) fail("Fresh video could not be verified. Retry with a supported browser.");
    } else if (!connectedAt) state("connecting", "Waiting for fresh video frames…");
  }
  async function poll() {
    if (stopped) return;
    try {
      const generation = roomId ? `&room_id=${encodeURIComponent(roomId)}` : "";
      const result = await request(`${path}?peer_id=${encodeURIComponent(peerId)}&after=${cursor}${generation}`) as Poll;
      if (stopped) return;
      if (typeof result.room_id !== "string" || !result.room_id || !Number.isSafeInteger(result.epoch)
          || result.epoch < 1 || !Number.isSafeInteger(result.cursor) || result.cursor < 0 || !Array.isArray(result.signals)) {
        throw new Error("The server did not confirm a valid live connection generation.");
      }
      if (result.room_id !== roomId || result.epoch !== epoch) {
        closePeer();
        roomId = result.room_id;
        epoch = result.epoch;
        state("connecting", "The live connection changed. Waiting for a fresh connection…");
      }
      if (!result.peer_present) {
        closePeer();
        state("waiting", options.role === "professor" ? "Waiting for the student's live stream…" : "No professor is connected to live video.");
      } else {
        if (options.role === "student" && !peer) {
          const connection = makePeer();
          await connection.setLocalDescription(await connection.createOffer());
          if (stopped) return;
          await signal("offer", connection.localDescription);
        }
        for (const message of result.signals) {
          if (stopped) return;
          if (message.kind === "offer" && options.role === "professor") {
            // Candidates may arrive before SDP and are applied after remote description.
            const candidates = pendingCandidates;
            closePeer();
            pendingCandidates = candidates;
            const connection = makePeer();
            await connection.setRemoteDescription(JSON.parse(message.payload));
            await applyCandidates(connection);
            await connection.setLocalDescription(await connection.createAnswer());
            await signal("answer", connection.localDescription);
          } else if (message.kind === "answer" && options.role === "student" && peer) {
            await peer.setRemoteDescription(JSON.parse(message.payload));
            await applyCandidates(peer);
          } else if (message.kind === "candidate") {
            const candidate = JSON.parse(message.payload) as RTCIceCandidateInit;
            if (peer?.remoteDescription) await peer.addIceCandidate(candidate);
            else pendingCandidates.push(candidate);
          }
        }
      }
      cursor = result.cursor;
      await checkFreshFrames();
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    } catch (error) {
      if (stopped) return;
      if (error instanceof Error && error.name === "AttemptEnded") {
        state("ended", error.message);
        stop();
      } else fail(error instanceof Error ? error.message : "Live viewing is unavailable. Retry live viewing.");
    }
  }
  if (typeof RTCPeerConnection === "undefined" || (options.role === "student" && !options.stream)) {
    fail("Live video is unavailable in this browser or the assessed stream is missing.");
  } else {
    options.stream?.getTracks().forEach(track => track.addEventListener("ended", trackEnded));
    state("waiting", "Preparing authorized live viewing…");
    void poll();
  }
  return { stop };
}
