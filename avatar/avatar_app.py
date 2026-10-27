"""Talk to the avatar in your browser.

  browser mic -> Whisper -> Qwen3 (Ollama) -> Chatterbox voice -> FlashHead video (render_worker.py) -> browser

Run inside the `chatterbox` conda env (start_avatar_chat.sh does this). Set AVATAR_MOCK=1 to test the web
flow without any GPU models.

The exam is a fixed script of questions. After each answer the LLM adds one short reaction sentence (it never
grades), then the avatar asks the next fixed question. Student audio is never saved, only the text transcript
and timings go to /workspace/sessions/.
"""
import datetime
import hashlib
import io
import json
import os
import queue
import random
import re
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import asynccontextmanager

import numpy as np
import requests
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

MOCK = os.environ.get("AVATAR_MOCK") == "1"
WORK = os.environ.get("WORK", "/workspace")
# Old single-professor files; imported once as a profile if no profiles exist yet.
LEGACY_REF = os.environ.get("VOICE_REF", f"{WORK}/professor_ref.wav")
LEGACY_IMAGE = os.environ.get("AVATAR_IMAGE", f"{WORK}/professor.jpg")
LEGACY_NAME = os.environ.get("LEGACY_NAME", "Imported professor")
RENDER_URL = os.environ.get("RENDER_URL", "http://127.0.0.1:8190")
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
LLM = os.environ.get("LLM", "qwen3:8b")
PORT = int(os.environ.get("PORT", "7860"))
MEDIA = os.path.join(WORK, "avatar_media")
SESSIONS = os.path.join(WORK, "sessions")
PROFILES = os.path.join(WORK, "profiles")       # one folder per professor: photo.jpg, voice.wav, profile.json, lines.json
ACTIVE_FILE = os.path.join(PROFILES, "active.txt")
os.makedirs(MEDIA, exist_ok=True)
os.makedirs(PROFILES, exist_ok=True)
os.makedirs(SESSIONS, exist_ok=True)

# ---- Edit these to match a real exam -------------------------------------------------------------
GREETING = "Hello. This is a practice oral exam. I will ask you three easy questions, one at a time."
QUESTIONS = [
    ("Study guide card", "In your own words, what is a use case?"),
    ("Notes and concept map", "What is an actor in a use case diagram? Can you give me one example?"),
    ("Test assignment", "Tell me about one assignment you worked on. What was it about?"),
]
FOLLOWUPS_PER_QUESTION = int(os.environ.get("FOLLOWUPS", "1"))   # follow-ups per question, e.g. FOLLOWUPS=2 (each one adds an answer turn to the exam time)
CLOSING = "That is the end of the exam. Thank you for your time."
NOT_HEARD = "Sorry, I did not catch that. Could you say it again?"
# Stock lines used when the LLM output is unusable. All are pre-rendered at startup, so they cost no GPU time.
FALLBACK_FOLLOWUPS = ["Can you give me one example of that?", "Can you explain that a little more?",
                      "Why do you think that is?", "How would that work in practice?"]
FALLBACK_FOLLOWUP = FALLBACK_FOLLOWUPS[0]
LLM_REACTIONS = os.environ.get("LLM_REACTIONS") == "1"    # default: reactions come from the stock list (small models leak instructions)
FALLBACK_REACTIONS = ["Thank you.", "I see.", "Okay, got it.", "That makes sense.", "Good, thank you."]
FOLLOWUP_SYSTEM = (
    "You are a friendly professor giving an easy oral exam. Ask exactly ONE short, natural follow-up question "
    "(at most 15 words) about something the student just said. Start with a question word such as What, Why, How, "
    "Can, Could or Would. Never start with Like, So, Well, Okay or Right. Speak plainly. Do not grade, do not say "
    "whether it is right or wrong, do not give the answer, and do not add any other sentence."
)
# One of these is picked at random each time, so the same answer does not always get the same question.
# Questions about an assignment get their own set (picked when the exam question mentions "assignment").
ANGLES = [
    "Ask for one concrete example of what they just described.",
    "Ask why that matters or why someone would use it.",
    "Ask them to explain in their own words one thing they mentioned.",
    "Ask what a user or customer would actually do in that situation.",
    "If they sounded unsure, ask what they do remember about it. Otherwise ask them to say a bit more.",
]
ASSIGNMENT_ANGLES = [
    "Ask what their own part of the work was.",
    "Ask what the hardest part was and how they handled it.",
    "Ask what they learned from it.",
    "Ask what they would do differently next time.",
    "Ask them to describe one step of it in more detail.",
]
STARTERS = {"what", "why", "how", "can", "could", "would", "do", "does", "did", "is", "are", "was", "were",
            "which", "who", "where", "when", "have", "has", "should", "what's", "how's", "who's", "where's", "when's"}
FILLER_OPENER = re.compile(r"^(?:(?:like|so|well|okay|ok|right|alright|um|uh|hmm|now|actually|and)\b[,.]?\s+)+", re.I)
ACK_SYSTEM = (
    "You are a friendly professor giving an easy oral exam. React to the student's answers in ONE short sentence "
    "of at most 12 words. It must be a statement, not a question. Acknowledge what they said kindly. Do not grade "
    "and do not say whether it is right or wrong."
)
# ---------------------------------------------------------------------------------------------------

STATE = {"ready": False, "progress": "Starting...", "error": None, "build_error": None, "profile": None}
ACTIVE = {"id": None, "name": "", "image": None, "ref": None}     # the professor the exam is using now
MODELS_READY = threading.Event()
PREP_LOCK = threading.Lock()
CACHE = {}                        # sentence -> clip dict, for the fixed lines of the script
TTS_LOCK = threading.Lock()
SESSION = {"id": None, "stage": 0, "followups": 0, "asked": "", "exchange": [], "log": []}
whisper = None
tts = None


def split_sentences(text):
    """Split into sentences; fragments under 3 words ("Hello.") are merged into the next one."""
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
    out = []
    for i, s in enumerate(parts):
        if out and len(out[-1].split()) < 3:
            out[-1] += " " + s
        else:
            out.append(s)
    return out


# ---------------- stages ----------------
def synth(sentence):
    """Sentence -> 16 kHz wav file in the avatar's cloned voice. Returns (path, seconds)."""
    path = os.path.join(MEDIA, uuid.uuid4().hex[:10] + ".wav")
    if MOCK:
        t = np.arange(int(16000 * 1.5)) / 16000
        sf.write(path, (0.1 * np.sin(2 * np.pi * 220 * t)).astype("float32"), 16000)
        return path, 1.5
    import librosa
    with TTS_LOCK:
        wav = tts.generate(sentence, audio_prompt_path=ACTIVE["ref"], exaggeration=0.4, cfg_weight=0.5)
    a = wav.squeeze().cpu().numpy()
    a16 = librosa.resample(a, orig_sr=tts.sr, target_sr=16000)
    sf.write(path, a16, 16000)
    return path, len(a16) / 16000


def render(sentence, wav_path, seconds, name=None):
    """16 kHz wav -> mp4 of the avatar speaking it. Returns a clip dict for the browser."""
    name = name or os.path.splitext(os.path.basename(wav_path))[0] + ".mp4"
    out = os.path.join(MEDIA, name)
    t = time.perf_counter()
    if MOCK:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        "color=c=0x335577:s=512x512:d=1.5:r=25", "-i", wav_path, "-c:v", "libvpx-vp9",
                        "-deadline", "realtime", "-c:a", "libopus", "-shortest", out], check=True)
    else:
        r = requests.post(f"{RENDER_URL}/render", json={"audio": wav_path, "out": out, "image": ACTIVE["image"]}, timeout=600)
        r.raise_for_status()
    os.remove(wav_path)
    return {"url": "/media/" + name, "text": sentence, "audio_s": round(seconds, 1),
            "render_s": round(time.perf_counter() - t, 2)}


def clip_for(sentence):
    """Pre-render one fixed line for the active professor; the clip and an index are kept on disk across restarts."""
    if sentence not in CACHE:
        name = f"pre_{ACTIVE['id']}_{hashlib.sha1(sentence.encode()).hexdigest()[:10]}.mp4"
        CACHE[sentence] = render(sentence, *synth(sentence), name=name)
        with open(os.path.join(pdir(ACTIVE["id"]), "lines.json"), "w") as f:
            json.dump(CACHE, f)
    return CACHE[sentence]


def transcribe(data):
    if MOCK:
        return "this is a mock answer from the student"
    src = os.path.join(MEDIA, "in_" + uuid.uuid4().hex[:8] + ".webm")
    wav = src.replace(".webm", ".wav")
    try:
        with open(src, "wb") as f:
            f.write(data)
        if len(data) < 1000:
            print(f"[transcribe] recording too small ({len(data)} bytes), treating as silence", flush=True)
            return ""
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", wav],
                           capture_output=True, text=True)
        if r.returncode != 0:                      # bad or truncated recording: ask the student to repeat
            print(f"[transcribe] ffmpeg failed on {len(data)} bytes: {r.stderr.strip()[:300]}", flush=True)
            return ""
        segs, _ = whisper.transcribe(wav, language="en", vad_filter=True)
        return " ".join(s.text.strip() for s in segs).strip()
    finally:                                   # student audio is never kept
        for p in (src, wav):
            if os.path.exists(p):
                os.remove(p)


LEAK = re.compile(r"\b(student|professor|sentence|react|reaction|respond|instruction|prompt|we are|let me|let's|"
                  r"must be|statement|at most|one short)\b", re.I)


def strip_think(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    return text.split("<think>")[0].strip()       # an unclosed <think> means everything after it is reasoning


def clean_sentence(sent):
    sent = sent.replace("\u2019", "'")
    sent = re.sub(r'["\u201c\u201d]', "", sent)                           # quotation marks are not read aloud
    sent = sent.strip().lstrip("-*\u2022>\u2013\u2014 ").strip()       # drop list bullets and dashes
    sent = FILLER_OPENER.sub("", sent)                                     # "Like, how does..." -> "how does..."
    return sent[:1].upper() + sent[1:]


def usable(sent, max_words, question):
    """Reject empty, over-long, quoted, cut-off or instruction-leaking output (small models think out loud)."""
    if not sent or not sent[0].isalpha() or sent[-1] not in ".!?" or '"' in sent:
        return False
    if LEAK.search(sent) or len(sent.split()) > max_words:
        return False
    if question and sent.split()[0].strip(",;:").lower() not in STARTERS:
        return False
    return sent.endswith("?") == question


def pick_fallback(options, key):
    """A stock line not yet used in this exam, so the avatar does not repeat itself."""
    used = SESSION.setdefault(key, [])
    fresh = [o for o in options if o not in used] or options
    choice = random.choice(fresh)
    used.append(choice)
    return choice


def ask_llm(system, user, max_tokens=60, temperature=0.6):
    r = requests.post(f"{OLLAMA}/api/chat", json={
        "model": LLM, "stream": False, "think": False,
        "options": {"num_ctx": 4096, "num_predict": max_tokens, "temperature": temperature},
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": user + "\n/no_think"}],
    }, timeout=120)
    r.raise_for_status()
    raw = r.json()["message"]["content"]
    SESSION["raw"] = raw[:300]                    # kept in the session log for debugging
    return strip_think(raw)


def followup_prompt(exchange):
    angles = ASSIGNMENT_ANGLES if "assignment" in exchange[0].lower() else ANGLES
    return "\n\n".join(exchange) + f"\n\nHow to ask: {random.choice(angles)}\n\nWrite only your one follow-up question now."


def follow_up(exchange):
    """One short follow-up question about what the student just said. Tries twice before using a stock line."""
    if MOCK:
        return FALLBACK_FOLLOWUPS[0]
    for _ in range(2):
        try:
            text = ask_llm(FOLLOWUP_SYSTEM, followup_prompt(exchange), temperature=0.8)
            q = next((x for x in map(clean_sentence, split_sentences(text)) if usable(x, 18, True)), "")
            if q:
                return q
            SESSION["rejected"] = text[:200]
        except Exception as e:
            SESSION["rejected"] = f"error: {type(e).__name__}: {e}"
            break                                   # Ollama is down: do not wait for a second try
    return pick_fallback(FALLBACK_FOLLOWUPS, "used_fu")


def reaction(exchange):
    """One short, non-question reaction before the next fixed question."""
    if MOCK:
        return "Thanks, that is a useful point."
    if not LLM_REACTIONS:
        return pick_fallback(FALLBACK_REACTIONS, "used_re")
    try:
        text = ask_llm(ACK_SYSTEM, "\n\n".join(exchange) + "\n\nWrite only your one-sentence reaction now.",
                       max_tokens=40)
        r = next((x for x in map(clean_sentence, split_sentences(text)) if usable(x, 14, False)), "")
        if r:
            return r
        SESSION["rejected"] = text[:200]
    except Exception as e:
        SESSION["rejected"] = f"error: {type(e).__name__}: {e}"
    return pick_fallback(FALLBACK_REACTIONS, "used_re")


# ---------------- professor profiles ----------------
CONSENT_TEXT = ("I am the person in this photo and the voice in this recording, or I have their written permission to "
                "use them. I understand the photo and voice sample are stored on this machine to run oral exams, "
                "and that they can be deleted from this page at any time.")
MAX_UPLOAD = 25_000_000
ID_RE = re.compile(r"[a-z0-9-]{1,40}")


def pdir(pid):
    if not ID_RE.fullmatch(pid or ""):
        raise ValueError("bad profile id")
    return os.path.join(PROFILES, pid)


def read_meta(pid):
    with open(os.path.join(pdir(pid), "profile.json")) as f:
        return json.load(f)


def write_meta(pid, meta):
    with open(os.path.join(pdir(pid), "profile.json"), "w") as f:
        json.dump(meta, f, indent=2)


def is_complete(pid):
    d = pdir(pid)
    return all(os.path.exists(os.path.join(d, n)) for n in ("profile.json", "photo.jpg", "voice.wav"))


def list_profiles():
    out = []
    for pid in os.listdir(PROFILES):
        if ID_RE.fullmatch(pid) and os.path.exists(os.path.join(PROFILES, pid, "profile.json")):
            out.append({"id": pid, "name": read_meta(pid).get("name", pid), "complete": is_complete(pid)})
    return sorted(out, key=lambda p: p["name"].lower())


def create_profile(name):
    name = " ".join(str(name or "").split())[:60]
    if not name:
        raise ValueError("Enter the professor's name.")
    pid = (re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "professor") + "-" + uuid.uuid4().hex[:4]
    os.makedirs(pdir(pid))
    now = datetime.datetime.now().isoformat(timespec="seconds")
    write_meta(pid, {"id": pid, "name": name, "created": now,
                     "consent": {"given": True, "at": now, "statement": CONSENT_TEXT}})
    return pid


def process_photo(pid, data):
    """Any phone/camera photo -> upright square JPEG (the video model center-crops to a square anyway)."""
    from PIL import Image, ImageOps
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:
        raise ValueError("That file could not be read as an image. Use a JPG or PNG.")
    w, h = im.size
    if min(w, h) < 256:
        raise ValueError(f"The photo is too small ({w}x{h}). Use one that is at least 512 pixels on the short side.")
    side = min(w, h)
    left, top = (w - side) // 2, (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    if side > 1024:
        im = im.resize((1024, 1024), Image.LANCZOS)
    im.save(os.path.join(pdir(pid), "photo.jpg"), quality=95)
    return {"size": im.size[0], "low_res": side < 512}


def process_voice(pid, data):
    """Any audio the browser or a file gives us -> clean mono wav, leading silence trimmed, at most 30 s."""
    d = pdir(pid)
    src, out = os.path.join(d, "voice_in.bin"), os.path.join(d, "voice.wav")
    with open(src, "wb") as f:
        f.write(data)
    try:
        r = subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vn", "-af",
                            "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15",
                            "-ar", "24000", "-ac", "1", "-t", "30", out], capture_output=True, text=True)
        if r.returncode != 0:
            raise ValueError("That file could not be read as audio. Try a WAV, MP3 or M4A, or record in the browser.")
        try:
            audio, sr = sf.read(out)
        except Exception:
            audio, sr = np.zeros(0), 24000
        secs = len(audio) / sr
        if secs < 8:
            os.remove(out) if os.path.exists(out) else None
            raise ValueError(f"The voice sample has only {secs:.1f} s of speech. Please give 15 to 30 seconds.")
        if float(np.sqrt(np.mean(np.square(audio)))) < 0.003:
            os.remove(out)
            raise ValueError("The recording is almost silent. Check the microphone and try again.")
        return {"seconds": round(secs, 1)}
    finally:
        if os.path.exists(src):
            os.remove(src)


def delete_profile(pid):
    d = pdir(pid)
    shutil.rmtree(d, ignore_errors=True)
    for name in os.listdir(MEDIA):
        if name.startswith(f"pre_{pid}_"):
            os.remove(os.path.join(MEDIA, name))
    if ACTIVE["id"] == pid:
        ACTIVE.update(id=None, name="", image=None, ref=None)
        CACHE.clear()
        STATE.update(ready=False, profile=None, progress="Add a professor to begin")
        if os.path.exists(ACTIVE_FILE):
            os.remove(ACTIVE_FILE)


def fixed_lines():
    fixed = []
    for line in [GREETING] + [q for _, q in QUESTIONS] + [CLOSING, NOT_HEARD] + FALLBACK_FOLLOWUPS + FALLBACK_REACTIONS:
        fixed += split_sentences(line)
    return list(dict.fromkeys(fixed))


def activate_profile(pid):
    """Make this professor the one the exam uses and pre-render the fixed lines (clips saved from earlier runs are reused)."""
    with PREP_LOCK:
        MODELS_READY.wait()
        try:
            meta, d = read_meta(pid), pdir(pid)
            STATE.update(ready=False, error=None, build_error=None, profile={"id": pid, "name": meta["name"]},
                         progress="Loading the profile")
            ACTIVE.update(id=pid, name=meta["name"], image=os.path.join(d, "photo.jpg"), ref=os.path.join(d, "voice.wav"))
            CACHE.clear()
            try:
                with open(os.path.join(d, "lines.json")) as f:
                    saved = json.load(f)
            except Exception:
                saved = {}
            for sent, clip in saved.items():
                if os.path.exists(os.path.join(MEDIA, clip["url"].split("/")[-1])):
                    CACHE[sent] = clip
            fixed = fixed_lines()
            for i, sent in enumerate(fixed, 1):
                STATE["progress"] = f"Preparing the avatar's lines ({i}/{len(fixed)})"
                clip_for(sent)
            with open(ACTIVE_FILE, "w") as f:
                f.write(pid)
            STATE.update(ready=True, progress="Ready")
        except Exception as e:
            ACTIVE.update(id=None, name="", image=None, ref=None)
            CACHE.clear()
            STATE.update(ready=False, profile=None, progress="Add a professor to begin",
                         build_error=f"Could not build the avatar: {type(e).__name__}: {e}")


def import_legacy():
    """Earlier versions used /workspace/professor.jpg + professor_ref.wav; turn them into a profile once."""
    if os.path.exists(LEGACY_IMAGE) and os.path.exists(LEGACY_REF):
        pid = create_profile(LEGACY_NAME)
        meta = read_meta(pid)
        meta["consent"] = {"given": None, "note": "imported from earlier single-professor files; consent not recorded"}
        write_meta(pid, meta)
        with open(LEGACY_IMAGE, "rb") as f:
            process_photo(pid, f.read())
        shutil.copy(LEGACY_REF, os.path.join(pdir(pid), "voice.wav"))
        return pid
    return None


# ---------------- startup ----------------
def load_models():
    global whisper, tts
    try:
        if not MOCK:
            from faster_whisper import WhisperModel
            from chatterbox.tts import ChatterboxTTS
            STATE["progress"] = "Loading speech recognition"
            whisper = WhisperModel("small", device="cuda", compute_type="float16")
            STATE["progress"] = "Loading the voice"
            tts = ChatterboxTTS.from_pretrained(device="cuda")
            STATE["progress"] = "Loading the language model"
            requests.post(f"{OLLAMA}/api/generate", json={
                "model": LLM, "prompt": "hi", "stream": False, "think": False, "keep_alive": "60m",
                "options": {"num_ctx": 4096}}, timeout=300)
        STATE["progress"] = "Models loaded"
        MODELS_READY.set()
    except Exception as e:                       # shown in the page
        STATE["error"] = f"{type(e).__name__}: {e}"


def startup():
    load_models()
    if STATE["error"]:
        return
    try:
        done = [p["id"] for p in list_profiles() if p["complete"]]
        pid = None
        if os.path.exists(ACTIVE_FILE):
            with open(ACTIVE_FILE) as f:
                want = f.read().strip()
            pid = want if want in done else None
        pid = pid or (done[0] if done else import_legacy())
    except Exception as e:
        STATE["build_error"] = f"Could not load the saved profiles: {type(e).__name__}: {e}"
        pid = None
    if pid:
        activate_profile(pid)
    else:
        STATE["progress"] = "Add a professor to begin"


# ---------------- reply pipeline: TTS and rendering overlap ----------------
def pipeline_events(sentences, t0, acc=None):
    acc = acc if acc is not None else {}
    q_wav, q_out = queue.Queue(), queue.Queue()

    def tts_stage():
        try:
            for s in sentences:
                if s in CACHE:
                    q_wav.put((s, CACHE[s], None))
                else:
                    ts = time.perf_counter()
                    w = synth(s)
                    acc["tts_s"] = acc.get("tts_s", 0) + time.perf_counter() - ts
                    q_wav.put((s, None, w))
        except Exception as e:
            q_wav.put(e)
        q_wav.put(None)

    def render_stage():
        try:
            while True:
                item = q_wav.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    raise item
                s, cached, wav = item
                if cached is not None:
                    q_out.put(cached)
                else:
                    clip = render(s, *wav)
                    acc["render_s"] = acc.get("render_s", 0) + clip["render_s"]
                    q_out.put(clip)
        except Exception as e:
            q_out.put(e)
        q_out.put(None)

    threading.Thread(target=tts_stage, daemon=True).start()
    threading.Thread(target=render_stage, daemon=True).start()
    while True:
        item = q_out.get()
        if item is None:
            return
        if isinstance(item, Exception):
            yield {"type": "error", "message": f"{type(item).__name__}: {item}"}
            return
        acc["audio_s"] = acc.get("audio_s", 0) + item["audio_s"]
        yield {"type": "clip", "t": round(time.perf_counter() - t0, 2), **item}


def vram_mb():
    """GPU memory in use (MiB) from nvidia-smi, or None if unavailable."""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout.split()
        return int(out[0])
    except Exception:
        return None


EXAM_LIMIT_S = float(os.environ["EXAM_LIMIT_S"]) if os.environ.get("EXAM_LIMIT_S") else None   # no time limit unless set


def summary():
    turns = SESSION["log"]
    c = SESSION.get("client", {})
    speaking = round(sum(t.get("speaking_s") or 0 for t in turns), 1)
    waiting = round(sum(t.get("latency_s") or 0 for t in turns), 1)
    avatar = round(sum(t.get("avatar_audio_s") or 0 for t in turns), 1)
    total = c.get("total_s")
    return {"total_s": total, "limit_s": EXAM_LIMIT_S,
            "within_limit": (total <= EXAM_LIMIT_S) if (total is not None and EXAM_LIMIT_S) else None,
            "student_speaking_s": speaking, "waiting_on_system_s": waiting,
            "avatar_speaking_s_after_turns": avatar, "turns": len(turns),
            "peak_vram_mb": max([t["vram_mb"] for t in turns if t.get("vram_mb")] or [None])}


def save_session():
    with open(os.path.join(SESSIONS, f"session_{SESSION['id']}.json"), "w") as f:
        json.dump({"id": SESSION["id"], "model": LLM, "summary": summary(), "turns": SESSION["log"]}, f, indent=2)


def start_events():
    SESSION.update(id=datetime.datetime.now().strftime("%Y%m%d_%H%M%S"), stage=0, followups=0,
                   asked=QUESTIONS[0][1], exchange=[], log=[], client={})
    for k in ("used_fu", "used_re", "raw", "rejected"):
        SESSION.pop(k, None)
    keep = {c["url"].split("/")[-1] for c in CACHE.values()}
    for name in os.listdir(MEDIA):               # drop clips from earlier sessions
        if name.endswith(".mp4") and name not in keep and not name.startswith("pre_"):
            os.remove(os.path.join(MEDIA, name))
    t0 = time.perf_counter()
    yield from pipeline_events(split_sentences(GREETING) + split_sentences(QUESTIONS[0][1]), t0)
    yield {"type": "done", "finished": False}


def turn_events(data):
    t0 = time.perf_counter()
    stage = SESSION["stage"]
    if stage >= len(QUESTIONS):
        yield {"type": "done", "finished": True}
        return
    t = time.perf_counter()
    text = transcribe(data)
    asr_s = time.perf_counter() - t
    yield {"type": "heard", "text": text, "asr_s": round(asr_s, 2)}

    asked = SESSION["asked"]
    llm_s, avatar_reply, kind = 0.0, "", "not heard"
    if len(text.split()) < 2:
        sentences = split_sentences(NOT_HEARD)           # same question again, exam does not move on
    else:
        SESSION["exchange"].append(f"Professor: {asked}\nStudent: {text}")
        t = time.perf_counter()
        if SESSION["followups"] < FOLLOWUPS_PER_QUESTION:
            # ask a follow-up and wait for the student to answer it
            avatar_reply = follow_up(SESSION["exchange"])
            kind = "answer, follow-up asked"
            SESSION["followups"] += 1
            SESSION["asked"] = avatar_reply
            sentences = split_sentences(avatar_reply)
            llm_s = time.perf_counter() - t
        else:
            # done with this question: short reaction, then the next fixed question
            ack = reaction(SESSION["exchange"])
            llm_s = time.perf_counter() - t
            nxt = QUESTIONS[stage + 1][1] if stage + 1 < len(QUESTIONS) else CLOSING
            avatar_reply = f"{ack} {nxt}"
            kind = "answer, moved on"
            sentences = split_sentences(ack) + split_sentences(nxt)
            SESSION.update(stage=stage + 1, followups=0, exchange=[],
                           asked=nxt if stage + 1 < len(QUESTIONS) else "")

    first = last = None
    acc = {}
    for ev in pipeline_events(sentences, t0, acc):
        if ev["type"] == "clip":
            first = ev["t"] if first is None else first
            last = ev["t"]
        yield ev

    SESSION["log"].append({
        "question": QUESTIONS[stage][1], "asked": asked, "answer": text, "kind": kind,
        "avatar_reply": avatar_reply, "llm_raw": SESSION.pop("raw", ""), "llm_rejected": SESSION.pop("rejected", ""),
        "asr_s": round(asr_s, 2), "llm_s": round(llm_s, 2),
        "tts_s": round(acc.get("tts_s", 0), 2), "render_s": round(acc.get("render_s", 0), 2),
        "avatar_audio_s": round(acc.get("audio_s", 0), 1), "vram_mb": vram_mb(),
        "first_clip_ready_s": first, "all_clips_ready_s": last})
    save_session()
    L = SESSION["log"][-1]
    yield {"type": "done", "finished": SESSION["stage"] >= len(QUESTIONS),
           "timings": {"asr_s": L["asr_s"], "llm_s": L["llm_s"], "tts_s": L["tts_s"], "render_s": L["render_s"],
                       "vram_mb": L["vram_mb"], "first_clip_ready_s": first}}


def ndjson(gen):
    try:
        for ev in gen:
            yield json.dumps(ev) + "\n"
    except Exception as e:
        yield json.dumps({"type": "error", "message": f"{type(e).__name__}: {e}"}) + "\n"


# ---------------- web ----------------
@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=startup, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/", response_class=HTMLResponse)
def index():
    return INDEX_HTML.replace("%%CONSENT%%", json.dumps(CONSENT_TEXT))


@app.get("/status")
def status():
    return JSONResponse({**STATE, "models_loaded": MODELS_READY.is_set()})


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/avatar.jpg")
def avatar():
    if not ACTIVE["image"] or not os.path.exists(ACTIVE["image"]):
        return Response(status_code=404)
    return FileResponse(ACTIVE["image"], headers={"Cache-Control": "no-cache"})


def bad(msg, code=400):
    return JSONResponse({"error": msg}, status_code=code)


@app.get("/profiles")
def profiles():
    return JSONResponse({"profiles": list_profiles(), "active": ACTIVE["id"]})


@app.post("/profiles")
async def new_profile(request: Request):
    try:
        body = await request.json()
    except Exception:
        return bad("Bad request.")
    if body.get("consent") is not True:
        return bad("Consent is required: please tick the box.")
    try:
        return JSONResponse({"id": create_profile(body.get("name"))})
    except ValueError as e:
        return bad(str(e))


async def upload(request, pid, fn):
    try:
        pdir(pid)
        if not os.path.exists(os.path.join(PROFILES, pid, "profile.json")):
            return bad("Unknown profile.", 404)
        data = await request.body()
        if not data or len(data) > MAX_UPLOAD:
            return bad("The file is empty or larger than 25 MB.", 413 if data else 400)
        return JSONResponse(await run_in_threadpool(fn, pid, data))
    except ValueError as e:
        return bad(str(e))


@app.put("/profiles/{pid}/photo")
async def put_photo(pid: str, request: Request):
    return await upload(request, pid, process_photo)


@app.put("/profiles/{pid}/voice")
async def put_voice(pid: str, request: Request):
    return await upload(request, pid, process_voice)


@app.post("/profiles/{pid}/activate")
def activate(pid: str):
    try:
        if not is_complete(pid):
            return bad("This profile needs both a photo and a voice sample.")
    except (ValueError, OSError):
        return bad("Unknown profile.", 404)
    STATE.update(ready=False, error=STATE["error"], build_error=None, profile={"id": pid, "name": read_meta(pid)["name"]},
                 progress="Starting")
    threading.Thread(target=activate_profile, args=(pid,), daemon=True).start()
    return JSONResponse({"ok": True})


@app.post("/profiles/{pid}/delete")
def remove_profile(pid: str):
    try:
        delete_profile(pid)
    except ValueError:
        return bad("Unknown profile.", 404)
    return JSONResponse({"ok": True})


@app.get("/media/{name}")
def media(name: str):
    path = os.path.join(MEDIA, name)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.mp4", name) or not os.path.exists(path):
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(path, media_type="video/mp4")


@app.post("/start")
def start():
    if not STATE["ready"]:
        return JSONResponse({"error": "not ready"}, status_code=503)
    return StreamingResponse(ndjson(start_events()), media_type="application/x-ndjson")


@app.post("/metrics")
async def metrics(request: Request):
    """Browser-measured timings: {turn, speaking_s, latency_s} and, at the end, {final, total_s}."""
    m = await request.json()
    n = m.get("turn")
    if isinstance(n, int) and 1 <= n <= len(SESSION["log"]):
        SESSION["log"][n - 1]["speaking_s"] = m.get("speaking_s")
        SESSION["log"][n - 1]["latency_s"] = m.get("latency_s")
    if m.get("final"):
        SESSION["client"]["total_s"] = m.get("total_s")
    if SESSION["id"]:
        save_session()
    return JSONResponse(summary())


@app.post("/turn")
async def turn(request: Request):
    data = await request.body()
    if not STATE["ready"]:
        return JSONResponse({"error": "not ready"}, status_code=503)
    return StreamingResponse(ndjson(turn_events(data)), media_type="application/x-ndjson")


INDEX_HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oral exam avatar</title>
<style>
:root{--font:Arial,Helvetica,sans-serif;--bg:#f7f8fa;--fg:#172033;--muted:#687386;--soft:#7b8494;--card:#fff;--rule:#e0e4ea;--panel:#fafbfc;--panel-rule:#dce1e8;--accent:#172033;--accent-fg:#fff;--warn:#b42318;color-scheme:light}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 var(--font)}
.top{height:72px;display:flex;align-items:center;padding:0 max(16px,7%);background:#fff;border-bottom:1px solid #e6e8ec}
.logo{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700}
.logo-icon{width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:var(--accent);color:#fff;font-size:16px}
main{max-width:720px;margin:0 auto;padding:24px 16px 56px}
.card{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:28px}
.eyebrow{margin-bottom:8px;font-size:13px;font-weight:700;letter-spacing:1.5px;color:#53627a}
h1{font-size:32px;line-height:1.15;letter-spacing:-.8px;margin:0 0 18px}
h2{font-size:24px;line-height:1.2;letter-spacing:-.5px;margin:0 0 6px}
h3{font-size:15px;margin:26px 0 4px}
.hint{color:var(--muted);font-size:14px;margin:2px 0 10px}
.label{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--soft);margin:22px 0 6px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.bar select{flex:1;min-width:8em}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{font:inherit;font-size:15px;font-weight:600;padding:12px 20px;border-radius:9px;border:0;background:var(--accent);color:var(--accent-fg);cursor:pointer}
button:hover:not(:disabled){opacity:.9}
button:disabled{opacity:.4;cursor:default}
button.rec{background:var(--warn)}
button.small{font-size:13px;padding:8px 14px;border-radius:8px;background:#fff;color:var(--fg);border:1px solid #d5dbe4}
button.small:disabled{opacity:.45}
select,input[type=text],input[type=file]{font:inherit;font-size:15px;color:var(--fg);background:#fff;border:1px solid #d5dbe4;border-radius:8px;padding:10px 12px}
input[type=text]{width:100%}
input[type=range],input[type=checkbox]{accent-color:var(--accent)}
:focus-visible{outline:2px solid #53627a;outline-offset:2px}
.stage{position:relative;width:100%;aspect-ratio:1/1;background:var(--accent);border-radius:14px;overflow:hidden}
.stage img,.stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.stage video{opacity:0;transition:opacity .05s}
.caption{min-height:3.2em;margin:14px 0 6px;font-size:17px;line-height:1.5}
.status{color:var(--muted);font-size:14px}
.err{color:var(--warn)}
.metrics{margin:16px 0 0;padding:14px 16px;background:var(--panel);border:1px solid var(--panel-rule);border-radius:12px;font-size:14px;color:var(--muted);font-variant-numeric:tabular-nums;min-height:3em}
.metrics b{color:var(--fg)}
.log{margin:0;padding:0;list-style:none}
.log li{display:grid;grid-template-columns:72px 1fr;gap:8px;padding:10px 0;border-top:1px solid #eef1f5;font-size:15px}
.log b{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--soft);padding-top:3px}
.log li.you b{color:var(--fg)}
.log li.you span{font-weight:700}
blockquote{margin:8px 0 12px;padding:12px 14px;border-left:3px solid #d5dbe4;border-radius:0 8px 8px 0;background:var(--panel);color:var(--muted);font-size:14px}
.cropwrap{position:relative;width:min(384px,100%);aspect-ratio:1/1;margin:10px 0;border-radius:10px;overflow:hidden;background:var(--accent)}
.cropwrap canvas{width:100%;height:100%;touch-action:none;cursor:grab;display:block}
.guide{position:absolute;inset:12% 24% 6%;border:2px dashed rgba(255,255,255,.6);border-radius:50%;pointer-events:none}
.consent{display:flex;gap:10px;align-items:flex-start;margin:6px 0 16px;font-size:14px;color:var(--muted)}
.consent input{margin-top:.3em}
audio{width:100%;margin-top:10px}
#exam .eyebrow,#exam h1,#exam .caption{text-align:center}
#exam .stage{max-width:440px;margin:0 auto}
#exam .row{justify-content:center}
@media (max-width:600px){.card{padding:20px}h1{font-size:26px}.top{height:60px}}
</style></head><body><header class="top"><div class="logo"><span class="logo-icon">◉</span><span>OralExam AI</span></div></header><main>
<div class="bar"><select id="prof" aria-label="Professor"></select><button class="small" id="newbtn" type="button">New professor</button><button class="small" id="delbtn" type="button" disabled>Delete</button></div>
<section id="setup" class="card" hidden>
<div class="eyebrow">NEW PROFESSOR</div>
<h2>Set up a professor</h2>
<p class="hint">The avatar will speak in this person's voice and look like their photo. Both stay on this machine.</p>
<p class="hint" id="mstatus"></p>
<label for="pname"><b>Name</b> (shown as the page title)</label>
<input type="text" id="pname" maxlength="60" placeholder="Dr. Smith" autocomplete="off">
<h3>1. Photo</h3>
<p class="hint">Head and shoulders, facing the camera, even light, mouth closed and relaxed. Drag to move, then zoom so the face fills about half the square. Full-body photos make a small, blurry face.</p>
<input type="file" id="pfile" accept="image/*">
<div class="cropwrap"><canvas id="cropc" width="384" height="384"></canvas><div class="guide"></div></div>
<input type="range" id="zoom" min="0" max="100" value="0" disabled aria-label="Zoom" style="width:min(384px,100%)">
<div class="hint" id="crophint"></div>
<h3>2. Voice</h3>
<p class="hint">Read this in your normal speaking voice for 15 to 30 seconds, in a quiet room, with no music behind you. Or upload a clean recording of one speaker.</p>
<blockquote>Welcome to class. Today we are going to talk about how people use software to reach their goals. A good example is ordering a book online. You search for the title, add it to your cart, and check out. Each of those steps is part of a larger story, and understanding that story is the first step toward designing a good system.</blockquote>
<div class="row"><button id="recbtn" type="button">Record</button><span class="status" id="rectime"></span></div>
<p class="hint">or upload a file:</p>
<input type="file" id="vfile" accept="audio/*">
<audio id="vprev" controls hidden></audio>
<h3>3. Consent</h3>
<label class="consent"><input type="checkbox" id="consent"><span id="consenttext"></span></label>
<div class="row"><button id="build" type="button" disabled>Build avatar</button><button class="small" id="cancelsetup" type="button" hidden>Cancel</button></div>
<p class="status" id="bstatus"></p>
</section>
<section id="exam" class="card" hidden>
<div class="eyebrow">ORAL EXAM</div>
<h1 id="title">Oral exam</h1>
<div class="stage"><img id="still" alt="Avatar"><video id="v0" playsinline></video><video id="v1" playsinline></video></div>
<div class="caption" id="caption"></div>
<div class="row"><button id="start" disabled>Start exam</button><button id="talk" disabled>Answer</button><span class="status" id="status">Connecting...</span></div>
<div class="metrics" id="metrics">Timings appear here after your first answer.</div>
<div class="label">TRANSCRIPT</div>
<ul class="log" id="log"></ul>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const vids=[$('v0'),$('v1')];let cur=0,playing=false,streaming=false,finished=false,started=false;
const q=[];let awaitingFirst=false,tEnd=0,lastTimings=null,turnNo=0,tRecStart=0,pendingM=null,examT0=0,lastLat=null;

function logLine(who,text){const li=document.createElement('li');li.innerHTML='<b></b><span></span>';li.className=who==='You'?'you':'';li.firstChild.textContent=who;li.lastChild.textContent=text;$('log').appendChild(li)}
function show(i){vids.forEach((v,k)=>v.style.opacity=(k===i)?1:0)}
function startClip(c){const v=vids[cur];if(v.dataset.src!==c.url){v.src=c.url;v.dataset.src=c.url}
  if(!examT0)examT0=performance.now();
  show(cur);playing=true;$('caption').textContent=c.text;logLine('Avatar',c.text);v.play().catch(e=>{if(e.name==='NotAllowedError')setStatus('Playback blocked: '+e.message,true)});preload()}
function preload(){const n=vids[1-cur];if(q.length){n.src=q[0].url;n.dataset.src=q[0].url;n.load()}}
function enqueue(c){if(!playing)startClip(c);else{q.push(c);if(q.length===1)preload()}}
vids.forEach((v,k)=>{
  v.addEventListener('playing',()=>{if(awaitingFirst&&k===cur){awaitingFirst=false;const lat=(performance.now()-tEnd)/1000;lastLat=lat;if(pendingM)pendingM.latency_s=+lat.toFixed(2);showMetrics(lat)}});
  const advance=()=>{if(k!==cur)return;if(q.length){const c=q.shift();cur=1-cur;startClip(c)}else{playing=false;show(-1);$('caption').textContent='';maybeIdle()}};
  v.addEventListener('ended',advance);
  v.addEventListener('error',()=>{if(v.dataset.src){setStatus('A clip failed to play: '+(v.error&&v.error.message),true);advance()}});
});
function setStatus(t,err){$('status').textContent=t;$('status').className='status'+(err?' err':'')}
function showMetrics(lat){const t=lastTimings;let s='You stopped talking to the avatar speaking: <b>'+lat.toFixed(1)+' s</b>';
  if(t)s+='<br>Transcribe '+t.asr_s+' s, LLM '+t.llm_s+' s, voice '+t.tts_s+' s, video '+t.render_s+' s, first clip ready on the server at '+t.first_clip_ready_s+' s'+(t.vram_mb?'<br>GPU memory in use: '+t.vram_mb+' MiB':'');
  $('metrics').innerHTML=s}
function sendMetrics(final){const m=pendingM||{};pendingM=null;if(final){m.final=true;m.total_s=+((performance.now()-examT0)/1000).toFixed(1)}
  fetch('/metrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m)}).then(r=>r.json()).then(s=>{if(final)showSummary(s)}).catch(()=>{})}
function showSummary(s){const lim=s.limit_s?(' of '+s.limit_s+' s &mdash; <b>'+(s.within_limit?'within the limit':'over the limit')+'</b>'):'';$('metrics').innerHTML='<b>Exam summary</b><br>Total time: <b>'+s.total_s+' s</b>'+lim+'<br>You speaking: '+s.student_speaking_s+' s<br>Waiting on the system: '+s.waiting_on_system_s+' s<br>Avatar speaking: '+s.avatar_speaking_s_after_turns+' s (after turn 1)'+(s.peak_vram_mb?'<br>Peak GPU memory: '+s.peak_vram_mb+' MiB':'')}
function maybeIdle(){if(streaming||playing||q.length)return;
  if(pendingM&&!finished)sendMetrics(false);
  if(finished){sendMetrics(true);setStatus('Exam finished. Click Start exam to run it again.');$('start').disabled=false;$('talk').disabled=true;$('prof').disabled=false}
  else if(started){setStatus('Your turn. Click Answer and speak.');$('talk').disabled=false}}

async function readStream(res,onEvent){
  const rd=res.body.getReader(),dec=new TextDecoder();let buf='';
  for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(line)onEvent(JSON.parse(line))}}
}
function onEvent(ev){
  if(ev.type==='clip')enqueue(ev);
  else if(ev.type==='heard'){logLine('You',ev.text||'(nothing heard)');setStatus('Avatar is thinking...')}
  else if(ev.type==='error'){setStatus(ev.message,true);streaming=false}
  else if(ev.type==='done'){streaming=false;finished=ev.finished;lastTimings=ev.timings||null;if(awaitingFirst&&!ev.timings)awaitingFirst=false;maybeIdle()}
}
async function post(url,body){streaming=true;const res=await fetch(url,{method:'POST',body});
  if(!res.ok){streaming=false;setStatus('Server said '+res.status,true);return}await readStream(res,onEvent)}

$('start').onclick=async()=>{
  $('start').disabled=true;$('talk').disabled=true;$('prof').disabled=true;$('log').innerHTML='';$('metrics').textContent='Timings appear here after your first answer.';
  started=true;finished=false;q.length=0;turnNo=0;examT0=0;pendingM=null;setStatus('Avatar is preparing...');
  await post('/start');
};
let rec=null,chunks=[],mic=null;
$('talk').onclick=async()=>{
  if(rec&&rec.state==='recording'){rec.stop();return}
  try{mic=mic||await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})}
  catch(e){setStatus('Microphone blocked: '+e.message,true);return}
  chunks=[];rec=new MediaRecorder(mic);
  rec.ondataavailable=e=>chunks.push(e.data);
  rec.onstop=async()=>{tEnd=performance.now();awaitingFirst=true;turnNo++;pendingM={turn:turnNo,speaking_s:+((tEnd-tRecStart)/1000).toFixed(2),latency_s:null};$('talk').textContent='Answer';$('talk').classList.remove('rec');$('talk').disabled=true;
    setStatus('Processing...');await post('/turn',new Blob(chunks,{type:rec.mimeType}))};
  rec.start();tRecStart=performance.now();$('talk').textContent='Done speaking';$('talk').classList.add('rec');setStatus('Listening...');
};
// ---------- professor profiles ----------
let building=false,hasProfiles=false;
const bs=(t,err)=>{$('bstatus').textContent=t;$('bstatus').className='status'+(err?' err':'')};
$('consenttext').textContent=%%CONSENT%%;
function showSetup(on){$('setup').hidden=!on;$('exam').hidden=on;$('cancelsetup').hidden=!(on&&hasProfiles)}
async function loadProfiles(){const r=await (await fetch('/profiles')).json();const sel=$('prof');sel.innerHTML='';
  r.profiles.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+(p.complete?'':' (incomplete)');sel.appendChild(o)});
  hasProfiles=r.profiles.length>0;if(r.active)sel.value=r.active;$('delbtn').disabled=!r.active;return r}
async function onReady(s){building=false;await loadProfiles();$('title').textContent=s.profile.name;document.title=s.profile.name+' - oral exam';
  $('still').src='/avatar.jpg?v='+encodeURIComponent(s.profile.id)+'&t='+Date.now();showSetup(false);
  setStatus('Ready. Click Start exam.');$('start').disabled=false;$('prof').disabled=false}
async function poll(){
  try{const s=await (await fetch('/status')).json();
    if(s.error){setStatus(s.error,true);bs(s.error,true);return}
    if(building&&s.build_error){building=false;bs(s.build_error,true);$('build').disabled=false;await loadProfiles();return}
    if(s.ready){await onReady(s);return}
    if(!s.profile&&!building){await loadProfiles();showSetup(true);$('mstatus').textContent=s.models_loaded?'':'The models are still loading ('+s.progress+'). You can fill this in meanwhile.'}
    else{setStatus(s.progress+'...');if(building)bs(s.progress+'...')}
  }catch(e){setStatus('Waiting for server...')}
  setTimeout(poll,1500)}
async function api(url,method,body,json){const r=await fetch(url,{method,body:json?JSON.stringify(json):body,headers:json?{'Content-Type':'application/json'}:{}});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('Server said '+r.status));return j}

// photo crop
const crop={img:null,cx:0,cy:0,L:0,minL:0,maxL:0};
function cropClamp(){const w=crop.img.naturalWidth,h=crop.img.naturalHeight;crop.L=Math.max(crop.minL,Math.min(crop.L,crop.maxL));
  crop.cx=Math.max(crop.L/2,Math.min(w-crop.L/2,crop.cx));crop.cy=Math.max(crop.L/2,Math.min(h-crop.L/2,crop.cy))}
function cropDraw(){const c=$('cropc'),x=c.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,c.width,c.height);if(!crop.img)return;
  x.drawImage(crop.img,crop.cx-crop.L/2,crop.cy-crop.L/2,crop.L,crop.L,0,0,c.width,c.height);
  $('crophint').textContent=crop.L<400?'Low resolution here: zoom out or use a larger photo.':''}
$('pfile').onchange=e=>{const f=e.target.files[0];if(!f)return;const im=new Image();
  im.onload=()=>{crop.img=im;const w=im.naturalWidth,h=im.naturalHeight;crop.maxL=Math.min(w,h);crop.minL=crop.maxL/4;crop.L=crop.maxL;
    crop.cx=w/2;crop.cy=h>w?crop.L/2+(h-crop.L)*0.3:h/2;cropClamp();$('zoom').value=0;$('zoom').disabled=false;cropDraw();bs('');checkBuild()};
  im.onerror=()=>{crop.img=null;cropDraw();bs('Could not read that image. Use a JPG or PNG.',true);checkBuild()};
  im.src=URL.createObjectURL(f)};
$('zoom').oninput=()=>{if(!crop.img)return;crop.L=crop.maxL-(crop.maxL-crop.minL)*$('zoom').value/100;cropClamp();cropDraw()};
let drag=null;const cc=$('cropc');
cc.onpointerdown=e=>{if(!crop.img)return;drag={x:e.clientX,y:e.clientY};cc.setPointerCapture(e.pointerId)};
cc.onpointermove=e=>{if(!drag)return;const k=crop.L/cc.clientWidth;crop.cx-=(e.clientX-drag.x)*k;crop.cy-=(e.clientY-drag.y)*k;drag={x:e.clientX,y:e.clientY};cropClamp();cropDraw()};
cc.onpointerup=cc.onpointercancel=()=>{drag=null};
function cropBlob(){return new Promise(res=>{const o=document.createElement('canvas');o.width=o.height=768;
  o.getContext('2d').drawImage(crop.img,crop.cx-crop.L/2,crop.cy-crop.L/2,crop.L,crop.L,0,0,768,768);o.toBlob(res,'image/jpeg',0.95)})}

// voice: record or upload
let vrec=null,voiceBlob=null,vtimer=null;
$('recbtn').onclick=async()=>{
  if(vrec&&vrec.state==='recording'){vrec.stop();return}
  let st;try{st=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}})}
  catch(e){bs('Microphone blocked: '+e.message,true);return}
  const chunks=[],t0=Date.now();vrec=new MediaRecorder(st);
  vrec.ondataavailable=e=>chunks.push(e.data);
  vrec.onstop=()=>{clearInterval(vtimer);st.getTracks().forEach(t=>t.stop());voiceBlob=new Blob(chunks,{type:vrec.mimeType});
    $('vprev').src=URL.createObjectURL(voiceBlob);$('vprev').hidden=false;$('recbtn').textContent='Record again';checkBuild()};
  vrec.start();bs('');$('recbtn').textContent='Stop';vtimer=setInterval(()=>{$('rectime').textContent=((Date.now()-t0)/1000).toFixed(0)+' s'},250)};
$('vfile').onchange=e=>{const f=e.target.files[0];if(f){voiceBlob=f;$('vprev').src=URL.createObjectURL(f);$('vprev').hidden=false;checkBuild()}};

function checkBuild(){$('build').disabled=building||!($('pname').value.trim()&&crop.img&&voiceBlob&&$('consent').checked)}
['pname','consent'].forEach(id=>{$(id).oninput=checkBuild;$(id).onchange=checkBuild});
$('build').onclick=async()=>{
  building=true;$('build').disabled=true;bs('Saving...');let id=null;
  try{id=(await api('/profiles','POST',null,{name:$('pname').value,consent:$('consent').checked})).id;
    bs('Uploading the photo...');await api('/profiles/'+id+'/photo','PUT',await cropBlob());
    bs('Checking the voice sample...');const v=await api('/profiles/'+id+'/voice','PUT',voiceBlob);
    bs('Voice sample OK ('+v.seconds+' s). Building the avatar...');
    await api('/profiles/'+id+'/activate','POST');setTimeout(poll,500)}
  catch(e){building=false;bs(e.message,true);if(id)fetch('/profiles/'+id+'/delete',{method:'POST'});checkBuild()}};
$('newbtn').onclick=()=>{$('pname').value='';$('consent').checked=false;crop.img=null;voiceBlob=null;$('vprev').hidden=true;$('pfile').value='';$('vfile').value='';
  $('zoom').disabled=true;cropDraw();$('recbtn').textContent='Record';$('rectime').textContent='';bs('');checkBuild();showSetup(true)};
$('cancelsetup').onclick=()=>showSetup(false);
$('prof').onchange=async()=>{const id=$('prof').value;$('start').disabled=true;$('talk').disabled=true;$('log').innerHTML='';$('caption').textContent='';
  finished=false;started=false;q.length=0;setStatus('Switching...');
  try{await api('/profiles/'+id+'/activate','POST');poll()}catch(e){setStatus(e.message,true)}};
let delArmed=null;
$('delbtn').onclick=async()=>{const id=$('prof').value;if(!id)return;
  if(!delArmed){$('delbtn').textContent='Really delete? Click again';delArmed=setTimeout(()=>{delArmed=null;$('delbtn').textContent='Delete'},4000);return}
  clearTimeout(delArmed);delArmed=null;$('delbtn').textContent='Delete';
  try{await api('/profiles/'+id+'/delete','POST');const r=await loadProfiles();
    if(r.profiles.length){const nx=r.profiles.find(p=>p.complete);if(nx){await api('/profiles/'+nx.id+'/activate','POST');poll();return}}
    poll()}catch(e){setStatus(e.message,true)}};
cropDraw();poll();
</script></body></html>
"""

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
