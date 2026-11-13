# Updating an existing air-gapped Ubuntu deployment

This package replaces the application and Ollama containers while reusing the
existing PostgreSQL database, Ollama model volume, and exam-recording volume.
It does not initialize a new database, include student data, or download
models on the air-gapped server. The host must have Docker Engine and Docker
Compose v2.24 or newer.

## 1. Build the transfer bundle on a connected machine

From the repository root in PowerShell, with Docker running:

```powershell
.\scripts\export_airgap_images.ps1 -OutputDirectory C:\Airgap\OralExamUpdate
```

The script builds the backend and frontend images, pulls the Ollama runtime
image, and writes `images.tar`, a SHA-256 checksum, the Compose file, an example
environment, and the three required database migrations. It never copies
`.env`, recordings, student photos, or model weights. Transfer the bundle using
the institution's approved offline media process.

## 2. Prepare the Ubuntu server

Back up the PostgreSQL database and all persistent volumes before upgrading.
Copy the bundle to the server. In the existing deployment, identify the Docker
network shared by the `db` and `ollama` services and the existing volumes for
Ollama models and exam recordings:

```bash
docker network ls
docker volume ls
docker inspect <backend-container> --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}'
docker inspect <ollama-container> --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}'
```

Create a server-local `.env` from `env.example`. Set `APP_DOCKER_NETWORK`,
`OLLAMA_MODELS_VOLUME`, and `EXAM_VIDEO_VOLUME` to the exact existing names.
Do not use the example placeholder names. Configure `DATABASE_URL`,
`POSTGRES_PASSWORD`, `AUTH_SECRET_KEY`, and `ADMIN_BOOTSTRAP_TOKEN`. Use a
URL-safe random database password (for example, hex output from
`openssl rand -hex 32`) so it is valid in `DATABASE_URL`.

Replace `EXAM_VIDEO_RETENTION_UNTIL` with the institution-approved `YYYY-MM-DD`
date. Set `FACE_MODELS_DIR` to the directory containing both licensed model
files, and `TLS_CERT_DIR` to a directory containing `fullchain.pem` and
`privkey.pem`. The TLS certificate must be trusted by student devices. Choose
unused host ports if ports 80 or 443 are already in use.

Load the application images offline:

```bash
sha256sum -c images.tar.sha256
docker load -i images.tar
```

The configured `OLLAMA_MODEL` must already exist in the existing Ollama model
volume. The service runs `ollama serve` only; it does not pull or create
models. Its model volume is external and is not replaced.

## 3. Apply database migrations and switch containers

From the existing repository deployment directory, stop and remove only the
old backend and Ollama containers, leaving PostgreSQL running. Do not pass
`-v`:

```bash
docker compose stop backend ollama
docker compose rm -f backend ollama
```

Apply migrations from the bundle to the existing database in order, and stop
if any command fails:

```bash
docker compose exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /path/to/bundle/database/migrations/013_student_photo_verification.sql
docker compose exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /path/to/bundle/database/migrations/014_exam_video_recordings.sql
docker compose exec -T db sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /path/to/bundle/database/migrations/015_block_face_check_overrides.sql
```

Then start the new stack from the bundle directory, where its `.env` is stored:

```bash
docker compose -f docker-compose.airgap.yml up -d
docker compose -f docker-compose.airgap.yml ps
docker compose -f docker-compose.airgap.yml logs --tail=100 backend frontend ollama
```

The frontend redirects HTTP to HTTPS and proxies `/api` to the backend. The
backend joins the existing application network to reach PostgreSQL and
Ollama. Both persistent data volumes are declared external, so Compose fails
instead of silently creating empty replacements if their names are wrong. The
database port and backend port are not published to the host.

Confirm the required model is present after the Ollama service starts:

```bash
docker compose -f docker-compose.airgap.yml exec ollama ollama list
```

Do not run `docker compose -f docker-compose.airgap.yml down -v`; it deletes
the named volumes. Configure a daily cleanup job with the same environment and
recording volume:

```bash
docker compose -f docker-compose.airgap.yml run --rm --no-deps backend python -m app.purge_exam_videos
```

## 4. Verify before student use

- Confirm backend health with
  `docker compose -f docker-compose.airgap.yml exec backend python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health/db').read().decode())"`.
- Open the HTTPS address from a student device and verify its certificate is
  trusted before granting camera access.
- Test the roster-photo check with approved synthetic records and verify
  professor-owned playback. Do not use real student photos or recordings for
  smoke tests.
- Test daily cleanup, backup restoration, storage permissions, and retention
  behavior according to institutional policy.

This repository has not been built with Docker or deployed to the target Ubuntu
server in this environment. Verify image compatibility, GPU availability,
network and volume names, storage permissions, backups, migrations, TLS, and
retention on the actual server before using it for an exam.
