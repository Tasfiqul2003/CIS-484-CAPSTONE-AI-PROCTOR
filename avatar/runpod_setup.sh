#!/usr/bin/env bash
# One-time setup for the full pipeline test on a RunPod Pod (Ubuntu, NVIDIA GPU, CUDA 12.8+ driver).
#   Whisper (faster-whisper) -> Qwen3 (Ollama) -> Chatterbox -> SoulX-FlashHead (Lite)
# Chatterbox and FlashHead use separate conda envs (different Python versions).
#
# Needs a container disk of 60 GB or more (the first attempt ran out of space at 30 GB).
# On Blackwell GPUs (RTX PRO 4000 etc.) both envs need torch 2.7.1 + cu128; torch 2.6 has no sm_120 kernels.
#
# Run in the background so a dropped browser tab doesn't kill it:
#   export MAX_JOBS=4
#   nohup bash runpod_setup.sh > setup.log 2>&1 &
#   tail -f setup.log          (ends with "Setup finished")
set -euo pipefail

WORK="${WORK:-/workspace}"
cd "$WORK"

AVAIL_GB=$(df --output=avail -BG "$WORK" | tail -n 1 | tr -dc '0-9')
if [ "$AVAIL_GB" -lt 45 ]; then
  echo "Only ${AVAIL_GB} GB free in $WORK. Need about 45 GB. Deploy with a bigger container disk." >&2
  exit 1
fi

export HF_HUB_ENABLE_HF_TRANSFER=0   # avoids the missing hf_transfer error on some templates
export PIP_NO_CACHE_DIR=1            # pip's cache was 5 GB on the first attempt
CU128="https://download.pytorch.org/whl/cu128"

echo "== System packages =="
apt-get update -y
apt-get install -y git ffmpeg curl wget libsndfile1 zstd

echo "== Conda =="
if ! command -v conda >/dev/null 2>&1; then
  wget -q https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -O miniconda.sh
  bash miniconda.sh -b -p "$WORK/miniconda"
  rm -f miniconda.sh
  eval "$("$WORK/miniconda/bin/conda" shell.bash hook)"
else
  eval "$(conda shell.bash hook)"
fi
CONDA_ARGS="-y -c conda-forge --override-channels"

echo "== Ollama + Qwen3 =="
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
if ! curl -s localhost:11434 >/dev/null 2>&1; then
  # 4096-token context keeps Ollama's VRAM near 6 GB instead of 10 GB at the 32k default
  OLLAMA_CONTEXT_LENGTH=4096 nohup ollama serve > "$WORK/ollama.log" 2>&1 &
  sleep 6
fi
ollama pull qwen3:8b

echo "== Chatterbox + faster-whisper env =="
conda create $CONDA_ARGS -n chatterbox python=3.11
conda activate chatterbox
# Install the Blackwell-capable torch first, then relax Chatterbox's torch==2.6.0 pin so pip keeps it.
pip install torch==2.7.1 torchaudio==2.7.1 --index-url "$CU128"
[ -d chatterbox ] || git clone https://github.com/resemble-ai/chatterbox.git
(cd chatterbox \
  && sed -i -E 's/(torch|torchaudio)==2\.6\.0/\1>=2.6.0/' pyproject.toml \
  && pip install -e .)
pip install faster-whisper soundfile requests
python -c "import torch; print('chatterbox env:', torch.__version__, torch.cuda.get_arch_list())"
conda deactivate

echo "== SoulX-FlashHead env =="
conda create $CONDA_ARGS -n flashhead python=3.10
conda activate flashhead
[ -d SoulX-FlashHead ] || git clone https://github.com/Soul-AILab/SoulX-FlashHead.git
cd SoulX-FlashHead
pip install torch==2.7.1 torchvision==0.22.1 --index-url "$CU128"
# requirements.txt pins nvidia-nccl-cu12==2.27.3, which conflicts with torch 2.7.1 (needs 2.26.2). Drop the nvidia-* pins.
grep -v 'nvidia-' requirements.txt > req_fixed.txt
pip install -r req_fixed.txt
pip install ninja
# Slow build (about 15 to 30 minutes with MAX_JOBS=4)
pip install flash_attn==2.8.0.post2 --no-build-isolation
pip install "huggingface_hub[cli]"
huggingface-cli download Soul-AILab/SoulX-FlashHead-1_3B --local-dir ./models/SoulX-FlashHead-1_3B
# only the PyTorch weights; the repo also holds TF and Flax copies
huggingface-cli download facebook/wav2vec2-base-960h --local-dir ./models/wav2vec2-base-960h \
  --include "*.json" "*.txt" "pytorch_model.bin"
python -c "import torch, flash_attn; print('flashhead env:', torch.__version__, flash_attn.__version__)"
conda deactivate
cd "$WORK"

conda clean -a -y >/dev/null 2>&1 || true
echo
df -h "$WORK" | tail -n 1
echo "Setup finished. Next: upload student_answer.wav, professor_ref.wav, professor.jpg and bench_stages.py to $WORK,"
echo "then run bench_stages.py inside the chatterbox env (run it twice; the second run is the warm one)."
