#!/usr/bin/env bash
# RunPod ONLY (not the JMU box): run the CYBROS exam app on a pod without Docker, with real AI.
#   Postgres 16 + pgvector, the FastAPI backend (minimal mode OFF), and the Vite frontend,
#   using the avatar folder's Ollama with qwen3:4b-instruct. Everything that must survive a
#   pod restart lives on the /workspace volume.
#
#   bash pod_exam_stack.sh setup     # after every pod (re)start: apt packages live on the container disk
#   bash pod_exam_stack.sh start     # start Ollama (if needed), Postgres, migrations, backend, Vite
#   bash pod_exam_stack.sh stop | status
#
# Ports on the pod: frontend 8100 (expose as HTTP), backend 8000, Ollama 8105, Postgres 5432 (local only).
set -euo pipefail

REPO="${REPO:-/workspace/repo}"
AVATAR="${AVATAR:-/workspace/avatar}"
STATE="${STATE:-/workspace/exam-stack}"
# Postgres needs to own its data folder, and the network volume does not allow chown, so the database
# lives on the container disk. It is recreated by `setup` after a pod restart (demo data only).
PGDATA="${PGDATA:-/var/lib/postgresql/cybros-pgdata}"
PGBIN=/usr/lib/postgresql/16/bin
NODE_VERSION="${NODE_VERSION:-22.22.1}"
MODEL="${LLM:-qwen3:4b-instruct}"
BACKEND_PORT=8000; FRONT_PORT=8100; OLLAMA_PORT=8105; DB_PORT=5432
SECRETS="$STATE/secrets.env"
LOGS="$STATE/logs"
export PATH="/opt/node/bin:$PATH"

say() { printf '\n== %s ==\n' "$*"; }
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
wait_port() { local i; for i in $(seq 1 "${2:-60}"); do listening "$1" && return 0; sleep 1; done; return 1; }

secrets() {
  mkdir -p "$STATE" "$LOGS"
  if [ ! -f "$SECRETS" ]; then
    umask 077
    python3 - > "$SECRETS" <<'PY'
import secrets
print(f"DB_PASSWORD={secrets.token_hex(16)}")
print(f"AUTH_SECRET_KEY={secrets.token_urlsafe(48)}")
print(f"ADMIN_BOOTSTRAP_TOKEN={secrets.token_urlsafe(24)}")
print(f"AVATAR_SERVICE_TOKEN={secrets.token_urlsafe(32)}")
PY
    echo "Created $SECRETS (read it with: cat $SECRETS). It stays on this pod's volume only."
  fi
  # shellcheck disable=SC1090
  . "$SECRETS"
}

setup() {
  [ -d "$REPO/backend" ] || { echo "Clone the repo to $REPO first." >&2; exit 1; }
  secrets
  say "System packages (Postgres 16 + pgvector)"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils >/dev/null
  if [ ! -x "$PGBIN/postgres" ]; then
    # Ubuntu 24.04 ships Postgres 16 and pgvector in its own repositories.
    apt-get install -y -qq postgresql-16 postgresql-16-pgvector >/dev/null
  fi

  say "Node $NODE_VERSION (on the pod disk; symlinks and scripts misbehave on the network volume)"
  if [ ! -x "/opt/node/bin/node" ]; then
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o /tmp/node.tar.xz
    mkdir -p "/opt/node" && tar --no-same-owner -xJf /tmp/node.tar.xz -C "/opt/node" --strip-components=1 && rm /tmp/node.tar.xz
  fi
  node -v

  say "Backend Python 3.12 venv (on the volume)"
  python3 -m pip install -q --upgrade uv
  [ -x "$STATE/venv/bin/python" ] || python3 -m uv venv --python 3.12 "$STATE/venv"
  python3 -m uv pip install -q --python "$STATE/venv/bin/python" -r "$REPO/backend/requirements.txt"

  say "Frontend packages"
  (cd "$REPO/frontend" && node "/opt/node/lib/node_modules/npm/bin/npm-cli.js" ci --no-audit --no-fund --no-bin-links)

  say "Database (first time only)"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    mkdir -p "$PGDATA" && chown -R postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
    su postgres -c "$PGBIN/initdb -D '$PGDATA' --auth-local=trust --auth-host=scram-sha-256" >/dev/null
    pg_start
    su postgres -c "psql -h /tmp -p $DB_PORT -v ON_ERROR_STOP=1 -q" <<SQL
CREATE ROLE proctor LOGIN PASSWORD '$DB_PASSWORD';
CREATE DATABASE oralexam_developer OWNER proctor;
\c oralexam_developer
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SQL
    echo "Database oralexam_developer created."
  else
    chown -R postgres:postgres "$PGDATA"
    echo "Database already exists; kept."
  fi
  echo "Setup finished"
}

pg_start() {
  if ! listening "$DB_PORT"; then
    su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -l '$LOGS/postgres.log' -o '-p $DB_PORT -k /tmp -c listen_addresses=127.0.0.1' -w start" >/dev/null
  fi
}

start() {
  secrets
  # The repo's migration script only accepts host "db" and database "oralexam_developer", so "db" maps to this pod.
  grep -qE '^127\.0\.0\.1[[:space:]]+db$' /etc/hosts || echo "127.0.0.1 db" >> /etc/hosts
  local db_url="postgresql+psycopg2://proctor:${DB_PASSWORD}@db:${DB_PORT}/oralexam_developer"

  say "Ollama with $MODEL on 127.0.0.1:$OLLAMA_PORT"
  if ! listening "$OLLAMA_PORT"; then
    OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" OLLAMA_MODELS="$AVATAR/ollama/models" OLLAMA_CONTEXT_LENGTH=4096 \
      nohup "$AVATAR/ollama/bin/ollama" serve > "$LOGS/ollama.log" 2>&1 &
    wait_port "$OLLAMA_PORT" 30 || { echo "Ollama did not start; see $LOGS/ollama.log" >&2; exit 1; }
  fi
  OLLAMA_HOST="127.0.0.1:$OLLAMA_PORT" "$AVATAR/ollama/bin/ollama" list | grep -q "^${MODEL}[[:space:]]" \
    || { echo "$MODEL is missing from $AVATAR/ollama/models (run pack_for_box.sh first)." >&2; exit 1; }

  say "Postgres"
  pg_start

  say "Migrations"
  (cd "$REPO" && DEVELOPER_MIGRATIONS=1 DATABASE_URL="$db_url" "$STATE/venv/bin/python" scripts/developer_migrate.py)

  say "Backend on 127.0.0.1:$BACKEND_PORT (real AI, minimal mode off)"
  if ! listening "$BACKEND_PORT"; then
    (cd "$REPO/backend" && env DATABASE_URL="$db_url" AUTH_SECRET_KEY="$AUTH_SECRET_KEY" \
        ADMIN_BOOTSTRAP_TOKEN="$ADMIN_BOOTSTRAP_TOKEN" AUTH_COOKIE_SECURE=false \
        OLLAMA_URL="http://127.0.0.1:$OLLAMA_PORT" OLLAMA_MODEL="$MODEL" \
        AVATAR_SERVICE_URL="http://127.0.0.1:8103" AVATAR_SERVICE_TOKEN="$AVATAR_SERVICE_TOKEN" \
        nohup "$STATE/venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" --reload \
        > "$LOGS/backend.log" 2>&1 & echo $! > "$STATE/backend.pid")
    wait_port "$BACKEND_PORT" 60 || { echo "Backend did not start:" >&2; tail -20 "$LOGS/backend.log" >&2; exit 1; }
  fi
  curl -s "http://127.0.0.1:$BACKEND_PORT/health/db"; echo

  say "Frontend (Vite) on 0.0.0.0:$FRONT_PORT"
  if ! listening "$FRONT_PORT"; then
    (cd "$REPO/frontend" && __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=".proxy.runpod.net" \
        nohup node node_modules/vite/bin/vite.js --host 0.0.0.0 --port "$FRONT_PORT" --strictPort \
        > "$LOGS/vite.log" 2>&1 & echo $! > "$STATE/vite.pid")
    wait_port "$FRONT_PORT" 30 || { echo "Vite did not start:" >&2; tail -20 "$LOGS/vite.log" >&2; exit 1; }
  fi
  cat <<EOF

Exam app is up.
  RunPod proxy:  https://<pod-id>-$FRONT_PORT.proxy.runpod.net
  or SSH tunnel: ssh -L $FRONT_PORT:127.0.0.1:$FRONT_PORT root@<pod-ip> -p <ssh-port>, then http://localhost:$FRONT_PORT
  Admin bootstrap token: in $SECRETS (ADMIN_BOOTSTRAP_TOKEN). Logs: $LOGS
EOF
}

stop() {
  for f in vite backend; do
    [ -f "$STATE/$f.pid" ] && kill "$(cat "$STATE/$f.pid")" 2>/dev/null || true
    rm -f "$STATE/$f.pid"
  done
  pkill -f "uvicorn app.main:app --host 127.0.0.1 --port $BACKEND_PORT" 2>/dev/null || true
  pkill -f "vite.js --host 0.0.0.0 --port $FRONT_PORT" 2>/dev/null || true
  [ -f "$PGDATA/postmaster.pid" ] && su postgres -c "$PGBIN/pg_ctl -D '$PGDATA' -m fast stop" >/dev/null || true
  echo "Stopped the exam app (Ollama and the avatar are left as they are). Data on $PGDATA is kept."
}

status() {
  for p in "$FRONT_PORT frontend" "$BACKEND_PORT backend" "$DB_PORT postgres" "$OLLAMA_PORT ollama" "8103 avatar" "8104 render-worker"; do
    set -- $p; if listening "$1"; then echo "up    $2 ($1)"; else echo "down  $2 ($1)"; fi
  done
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null | sed 's/^/GPU memory: /'
}

case "${1:-}" in
  setup) setup ;; start) start ;; stop) stop ;; status) status ;;
  *) echo "Usage: $0 setup|start|stop|status" >&2; exit 1 ;;
esac
