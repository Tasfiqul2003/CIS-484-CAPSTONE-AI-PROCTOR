#!/usr/bin/env bash
# Start the avatar prototype on the offline JMU box (no sudo, no conda install, no internet).
# Expects the folder packed by pack_for_box.sh unpacked at /home/cybros/avatar.
#   bash start_avatar_box.sh            then, from a laptop:
#   ssh -L 8103:127.0.0.1:8103 cybros@192.168.10.254   and open http://localhost:8103
# Everything listens on 127.0.0.1 only: the page has no login.
set -uo pipefail
WORK="${WORK:-/home/cybros/avatar}"
APP_PORT="${APP_PORT:-8103}"; FH_PORT="${FH_PORT:-8104}"; OLLAMA_PORT="${OLLAMA_PORT:-8105}"
MODEL="${LLM:-qwen3:4b-instruct}"
cd "$WORK" || { echo "Missing $WORK" >&2; exit 1; }
mkdir -p logs
CB="$WORK/miniconda/envs/chatterbox/bin"; FH="$WORK/miniconda/envs/flashhead/bin"   # env pythons, no conda activate

export WORK HF_HOME="$WORK/hf" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
export LLM="$MODEL" HOST=127.0.0.1 PORT="$APP_PORT" FH_PORT
export OLLAMA_URL="http://127.0.0.1:$OLLAMA_PORT" RENDER_URL="http://127.0.0.1:$FH_PORT"
export FH_DIR="$WORK/SoulX-FlashHead" FH_IMAGE="$WORK/professor.jpg"

for p in "$APP_PORT" "$FH_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "Port $p is in use; nothing was started." >&2; exit 1; fi
done
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader | sed 's/^/GPU memory in use before start: /'

if (exec 3<>"/dev/tcp/127.0.0.1/$OLLAMA_PORT") 2>/dev/null; then
  echo "Reusing the Ollama already running on 127.0.0.1:$OLLAMA_PORT"
  OLLAMA_PID=""
else
  echo "Starting Ollama on 127.0.0.1:$OLLAMA_PORT ..."
  OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" OLLAMA_MODELS="$WORK/ollama/models" OLLAMA_CONTEXT_LENGTH=4096 OLLAMA_KEEP_ALIVE=30m \
    nohup "$WORK/ollama/bin/ollama" serve > logs/ollama.log 2>&1 &
  OLLAMA_PID=$!
  sleep 6
fi
OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" "$WORK/ollama/bin/ollama" list | grep -q "^${MODEL}[[:space:]]" \
  || { echo "$MODEL is not in $WORK/ollama/models" >&2; [ -n "$OLLAMA_PID" ] && kill $OLLAMA_PID; exit 1; }

echo "Starting the FlashHead render worker (about a minute) ..."
PATH="$FH:$PATH" "$FH/python" "$WORK/render_worker.py" > logs/render_worker.log 2>&1 &
WORKER=$!
trap 'kill $WORKER ${OLLAMA_PID:-} 2>/dev/null' EXIT
for i in $(seq 1 120); do
  (exec 3<>"/dev/tcp/127.0.0.1/$FH_PORT") 2>/dev/null && break
  kill -0 $WORKER 2>/dev/null || { echo "Render worker died:" >&2; tail -n 25 logs/render_worker.log >&2; exit 1; }
  sleep 5
done
echo "Render worker is up. Web app: http://127.0.0.1:$APP_PORT (tunnel it to your laptop)."
PATH="$CB:$PATH" "$CB/python" "$WORK/avatar_app.py" 2>&1 | tee logs/app.log
