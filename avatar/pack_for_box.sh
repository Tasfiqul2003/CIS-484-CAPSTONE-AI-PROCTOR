#!/usr/bin/env bash
# Run ON THE POD after runpod_setup.sh finished. Makes the avatar folder self-contained for the offline box:
# Hugging Face weights, ffmpeg, the Ollama binary and qwen3:4b-instruct all end up inside the folder, and the
# folder no longer depends on its build path (the box uses /home/cybros/avatar).
#   export WORK=/home/cybros/avatar
#   nohup bash pack_for_box.sh > pack.log 2>&1 &  ;  tail -f pack.log      (ends with "Prep finished")
set -euo pipefail
WORK="$(cd "${WORK:-/home/cybros/avatar}" && pwd -P)"   # real path, not the symlink
cd "$WORK"
CB="$WORK/miniconda/envs/chatterbox/bin"; FH="$WORK/miniconda/envs/flashhead/bin"
export HF_HOME="$WORK/hf"
MODEL="${LLM:-qwen3:4b-instruct}"

echo "== ffmpeg inside both envs (the box may not have it) =="
"$WORK/miniconda/bin/conda" install -y -n chatterbox -c conda-forge --override-channels ffmpeg
"$WORK/miniconda/bin/conda" install -y -n flashhead  -c conda-forge --override-channels ffmpeg

echo "== Chatterbox as a normal install (an editable install points back at the build path) =="
"$CB/pip" install --no-deps "$WORK/chatterbox"

echo "== Hugging Face weights into $HF_HOME (whisper small + Chatterbox) =="
"$CB/python" -c "from faster_whisper import WhisperModel; from chatterbox.tts import ChatterboxTTS; WhisperModel('small', device='cuda', compute_type='float16'); ChatterboxTTS.from_pretrained(device='cuda'); print('weights cached')"

echo "== Ollama binary + $MODEL into $WORK/ollama =="
mkdir -p "$WORK/ollama/bin" "$WORK/ollama/lib" "$WORK/ollama/models"
cp -a "$(command -v ollama)" "$WORK/ollama/bin/"
[ -d /usr/local/lib/ollama ] && cp -a /usr/local/lib/ollama "$WORK/ollama/lib/"
pkill -f "ollama serve" || true; sleep 2
OLLAMA_MODELS="$WORK/ollama/models" OLLAMA_HOST=127.0.0.1:11434 nohup "$WORK/ollama/bin/ollama" serve > "$WORK/ollama.log" 2>&1 &
sleep 6
OLLAMA_HOST=127.0.0.1:11434 "$WORK/ollama/bin/ollama" pull "$MODEL"
OLLAMA_HOST=127.0.0.1:11434 "$WORK/ollama/bin/ollama" list

echo "== Offline check (Hugging Face switched off) =="
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "$CB/python" -c "from faster_whisper import WhisperModel; from chatterbox.tts import ChatterboxTTS; WhisperModel('small', device='cuda', compute_type='float16'); ChatterboxTTS.from_pretrained(device='cuda'); print('OFFLINE LOAD OK')"
"$FH/python" -c "import torch, flash_attn; print('flashhead env OK', torch.__version__, flash_attn.__version__, torch.cuda.get_device_name(0))"

echo "== Trim =="
"$WORK/miniconda/bin/conda" clean -a -y >/dev/null 2>&1 || true
rm -rf "$WORK/SoulX-FlashHead/models/SoulX-FlashHead-1_3B/Model_Pro"    # only Lite is used
rm -rf "$WORK"/{chatterbox,SoulX-FlashHead}/.git
du -sh "$WORK"
df -h "$WORK" | tail -1
echo "Prep finished"
