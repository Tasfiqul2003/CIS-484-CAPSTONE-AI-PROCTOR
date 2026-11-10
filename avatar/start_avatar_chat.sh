#!/usr/bin/env bash
# Start the talk-to-the-avatar test page on a Pod where runpod_setup.sh has already run.
# Needs in /workspace: avatar_app.py, render_worker.py. The professor's photo and voice are added on the web page.
#   bash start_avatar_chat.sh                      (default LLM qwen3:8b)
#   LLM=qwen3:4b bash start_avatar_chat.sh         (smaller LLM, saves about 2.5-3 GB of GPU memory)
# Then open the URL it prints. Stop with Ctrl+C.
set -uo pipefail
cd /workspace
source /workspace/miniconda/etc/profile.d/conda.sh

for f in avatar_app.py render_worker.py; do
  [ -f "$f" ] || { echo "Missing /workspace/$f" >&2; exit 1; }
done

if ! curl -s localhost:11434 >/dev/null 2>&1; then
  OLLAMA_CONTEXT_LENGTH=4096 nohup ollama serve > ollama.log 2>&1 &
  sleep 6
fi
MODEL="${LLM:-qwen3:8b}"            # e.g.  LLM=qwen3:4b bash start_avatar_chat.sh
export LLM="$MODEL"
ollama list | grep -q "^${MODEL}[[:space:]]" || { echo "${MODEL} is not pulled (ollama pull ${MODEL})" >&2; exit 1; }
echo "Using LLM: ${MODEL}"

echo "Starting the FlashHead render worker (about a minute: model load plus a warm-up render)..."
( conda activate flashhead; python /workspace/render_worker.py ) > render_worker.log 2>&1 &
WORKER=$!
trap 'kill $WORKER 2>/dev/null' EXIT

for i in $(seq 1 120); do
  curl -sf localhost:8190/health >/dev/null 2>&1 && break
  kill -0 $WORKER 2>/dev/null || { echo "Render worker died. Last lines of render_worker.log:" >&2; tail -n 25 render_worker.log >&2; exit 1; }
  sleep 5
done
curl -sf localhost:8190/health >/dev/null 2>&1 || { echo "Render worker did not start in 10 minutes." >&2; tail -n 25 render_worker.log >&2; exit 1; }
echo "Render worker is up."

echo
if [ -n "${RUNPOD_POD_ID:-}" ]; then
  echo "Open this in your browser (needs HTTP port 7860 exposed on the Pod):"
  echo "  https://${RUNPOD_POD_ID}-7860.proxy.runpod.net"
else
  echo "Web app will listen on port 7860."
fi
echo "First time: the page asks for a name, a photo and a voice sample. Building the avatar takes a minute or two."
echo

conda activate chatterbox
python /workspace/avatar_app.py
