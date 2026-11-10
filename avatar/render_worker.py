"""FlashHead render worker. Runs in the `flashhead` conda env and keeps the model loaded.

POST /render {"audio": "<16 kHz wav path>", "out": "<mp4 path>", "image": "<photo path, optional>"} -> renders the
avatar speaking that audio. "image" is the professor's photo; without it FH_IMAGE (or the warm-up placeholder) is used.
The first render after startup takes ~40 s (kernel warm-up), so this script does a warm-up render before
it starts listening. start_avatar_chat.sh waits for /health before launching the web app.

Env vars (all optional): FH_DIR, FH_CKPT, FH_WAV2VEC, FH_IMAGE, FH_PORT
"""
import os
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from typing import Optional

FH_DIR = os.environ.get("FH_DIR", "/workspace/SoulX-FlashHead")
os.chdir(FH_DIR)                      # flash_head loads configs by relative path
sys.path.insert(0, FH_DIR)

import imageio
import librosa
import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from loguru import logger
from pydantic import BaseModel

from flash_head.inference import (
    get_audio_embedding,
    get_base_data,
    get_infer_params,
    get_pipeline,
    run_pipeline,
)

CKPT = os.environ.get("FH_CKPT", "models/SoulX-FlashHead-1_3B")
WAV2VEC = os.environ.get("FH_WAV2VEC", "models/wav2vec2-base-960h")
IMAGE = os.environ.get("FH_IMAGE", "/workspace/professor.jpg")   # optional default photo
PORT = int(os.environ.get("FH_PORT", "8190"))
SEED = 42

logger.info("Loading FlashHead (lite)...")
pipeline = get_pipeline(world_size=1, ckpt_dir=CKPT, model_type="lite", wav2vec_dir=WAV2VEC)
P = get_infer_params()               # must come after get_pipeline (it fills in motion_frames_num)
LOCK = threading.Lock()


def render(audio_path: str, out_path: str, image: str = None) -> dict:
    t_start = time.perf_counter()
    image = image or IMAGE
    with LOCK:
        get_base_data(pipeline, cond_image_path_or_dir=image, base_seed=SEED, use_face_crop=False)

        sr, fps = P["sample_rate"], P["tgt_fps"]
        frame_num, motion = P["frame_num"], P["motion_frames_num"]
        slice_len = frame_num - motion
        samples_per_slice = slice_len * sr // fps
        cached_len = sr * P["cached_audio_duration"]
        end_idx = P["cached_audio_duration"] * fps
        start_idx = end_idx - frame_num

        audio, _ = librosa.load(audio_path, sr=sr, mono=True)
        remainder = len(audio) % samples_per_slice
        if remainder:
            audio = np.concatenate([audio, np.zeros(samples_per_slice - remainder, dtype=audio.dtype)])
        slices = audio.reshape(-1, samples_per_slice)

        dq = deque([0.0] * cached_len, maxlen=cached_len)
        frames = []
        for chunk in slices:
            dq.extend(chunk.tolist())
            emb = get_audio_embedding(pipeline, np.array(dq), start_idx, end_idx)
            video = run_pipeline(pipeline, emb)[motion:]
            frames.append(video.cpu())
        torch.cuda.synchronize()
        t_gen = time.perf_counter() - t_start

    tmp = out_path.replace(".mp4", "_noaudio.mp4")
    with imageio.get_writer(tmp, format="mp4", mode="I", fps=fps, codec="h264",
                            ffmpeg_params=["-bf", "0", "-pix_fmt", "yuv420p"]) as w:
        for f in frames:
            arr = f.numpy().astype(np.uint8)
            for i in range(arr.shape[0]):
                w.append_data(arr[i])
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmp, "-i", audio_path,
                    "-c:v", "copy", "-c:a", "aac", "-shortest", "-movflags", "+faststart", out_path],
                   check=True)
    os.remove(tmp)
    return {"chunks": len(slices), "generate_s": round(t_gen, 2),
            "total_s": round(time.perf_counter() - t_start, 2)}


# warm-up: the first render pays a one-time ~40 s cost
logger.info("Warm-up render (about a minute the first time)...")
with tempfile.TemporaryDirectory() as d:
    wav = os.path.join(d, "silence.wav")
    sf.write(wav, np.zeros(16000 * 2, dtype="float32"), 16000)
    warm_img = IMAGE
    if not os.path.exists(warm_img):          # fresh install: no professor yet, any picture warms the kernels up
        from PIL import Image
        warm_img = os.path.join(d, "placeholder.jpg")
        Image.new("RGB", (512, 512), (128, 128, 128)).save(warm_img)
    info = render(wav, os.path.join(d, "warm.mp4"), warm_img)
logger.info(f"Warm-up done: {info}")

app = FastAPI()


class Req(BaseModel):
    audio: str
    out: str
    image: Optional[str] = None


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/render")
def do_render(r: Req):
    if r.image and not os.path.exists(r.image):
        raise HTTPException(status_code=400, detail=f"photo not found: {r.image}")
    return render(r.audio, r.out, r.image)


if __name__ == "__main__":
    logger.info(f"Render worker listening on 127.0.0.1:{PORT}")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
