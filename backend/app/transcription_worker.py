"""Offline speech transcripts from completed, consented examination recordings.

Run separately from the API. PostgreSQL is the durable queue; no private text
or model output is logged, and no student content enters an assessment prompt.
"""
import argparse
from dataclasses import dataclass
from importlib.util import find_spec
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from uuid import UUID, uuid4

from sqlalchemy import text

from .db import open_session
from .exam_video import MAX_RECORDING_BYTES, _private_open, _recording_root, _safe_path

MAX_ATTEMPTS = 3
MAX_TRANSCRIPT_CHARS = 2_000_000
MAX_AUDIO_SECONDS = 4 * 60 * 60
ELIGIBLE = """v.status = 'completed' AND v.expires_at > clock_timestamp()
    AND s.status IN ('pending_grading', 'flagged', 'graded')
    AND s.record_examination AND s.generate_transcript
    AND s.recording_consent_status = 'consented' AND NOT s.developer_demo"""


@dataclass(frozen=True)
class Config:
    model_dir: Path
    threads: int = 1
    timeout: int = 900
    language: str | None = 'en'


def configuration():
    raw = os.getenv('EXAM_TRANSCRIPTION_MODEL_DIR', '').strip()
    path = Path(raw)
    if not raw or not path.is_absolute() or not path.is_dir():
        raise ValueError('Set EXAM_TRANSCRIPTION_MODEL_DIR to a complete local model directory.')
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        if not (path / name).is_file():
            raise ValueError('The local model is incomplete: model.bin, config.json and tokenizer.json are required.')
    threads = int(os.getenv('EXAM_TRANSCRIPTION_CPU_THREADS', '1'))
    timeout = int(os.getenv('EXAM_TRANSCRIPTION_TIMEOUT_SECONDS', '900'))
    language = os.getenv('EXAM_TRANSCRIPTION_LANGUAGE', 'en').strip().lower()
    if not 1 <= threads <= 8 or not 30 <= timeout <= 7200:
        raise ValueError('Transcription threads must be 1..8 and timeout 30..7200 seconds.')
    if language != 'auto' and not re.fullmatch('[a-z]{2,3}', language):
        raise ValueError('Use a language code such as en, or auto.')
    return Config(path, threads, timeout, None if language == 'auto' else language)


def load_model(config):
    # A complete absolute model directory prevents tokenizer fallback. These
    # flags also disable Hugging Face downloads if a dependency tries a lookup.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    from faster_whisper import WhisperModel
    return WhisperModel(str(config.model_dir), device='cpu', compute_type='int8',
                        cpu_threads=config.threads, num_workers=1, local_files_only=True)


def check_audio_decoder():
    """Exercise codec compatibility with synthetic silence, without private media."""
    import io
    import wave
    from faster_whisper.audio import decode_audio

    source = io.BytesIO()
    with wave.open(source, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes(3200))
    source.seek(0)
    if len(decode_audio(source)) != 1600:
        raise ValueError('Synthetic audio decoder validation failed.')


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f'{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}'


def transcribe(source, model, config):
    segments, info = model.transcribe(source, language=config.language, beam_size=1,
        condition_on_previous_text=False, vad_filter=False)
    if not math.isfinite(info.duration) or not 0 < info.duration <= MAX_AUDIO_SECONDS:
        raise ValueError('Unsupported recording duration.')
    lines, count = [], 0
    for segment in segments:
        if (not math.isfinite(segment.start) or not math.isfinite(segment.end)
                or not 0 <= segment.start <= segment.end <= MAX_AUDIO_SECONDS + 30):
            raise ValueError('Invalid speech timestamps.')
        speech = ' '.join(str(segment.text).split())
        if not speech:
            continue
        line = f'[{timestamp(segment.start)} - {timestamp(segment.end)}] {speech}'
        count += len(line) + 1
        if count > MAX_TRANSCRIPT_CHARS:
            raise ValueError('Speech transcript exceeds its size limit.')
        lines.append(line)
    # Empty text means the engine detected no speech; never invent a sentence.
    return '\n'.join(lines)


def claim_job(db, config):
    try:
        # A worker killed on its last attempt must eventually leave processing.
        db.execute(text("""UPDATE exam_session_videos SET transcript_status = 'failed',
            transcript_error = 'Transcription worker stopped before saving a result.',
            transcript_job_token = NULL, transcript_lease_until = NULL
            WHERE transcript_status = 'processing' AND transcript_lease_until <= clock_timestamp()
              AND transcript_attempts >= :max_attempts"""), {'max_attempts': MAX_ATTEMPTS})
        row = db.execute(text(f"""SELECT v.session_id FROM exam_session_videos v
            JOIN exam_sessions s ON s.id = v.session_id
            WHERE {ELIGIBLE} AND v.transcript_attempts < :max_attempts
              AND (v.transcript_status IN ('queued', 'unavailable')
                OR (v.transcript_status IN ('processing', 'failed')
                    AND (v.transcript_lease_until IS NULL OR v.transcript_lease_until <= clock_timestamp())))
            ORDER BY v.completed_at, v.session_id LIMIT 1
            FOR UPDATE OF v SKIP LOCKED"""), {'max_attempts': MAX_ATTEMPTS}).mappings().first()
        if not row:
            db.commit()
            return None
        sid, token = str(UUID(str(row['session_id']))), str(uuid4())
        db.execute(text("""UPDATE exam_session_videos SET transcript_status = 'processing',
            transcript_attempts = transcript_attempts + 1, transcript_job_token = CAST(:token AS uuid),
            transcript_lease_until = clock_timestamp() + (:lease_seconds * interval '1 second'),
            transcript_error = NULL WHERE session_id = CAST(:sid AS uuid)"""),
            {'sid': sid, 'token': token, 'lease_seconds': config.timeout + 60})
        db.commit()
        return sid, token
    except Exception:
        db.rollback()
        raise


def read_job(db, sid, token):
    return db.execute(text(f"""SELECT v.total_bytes FROM exam_session_videos v
        JOIN exam_sessions s ON s.id = v.session_id
        WHERE v.session_id = CAST(:sid AS uuid) AND {ELIGIBLE}
          AND v.transcript_status = 'processing'
          AND v.transcript_job_token = CAST(:token AS uuid)
          AND v.transcript_lease_until > clock_timestamp()"""),
        {'sid': sid, 'token': token}).mappings().first()


def save_job(db, sid, token, transcript):
    # A stale/crashed job cannot overwrite a newer worker or restore expired
    # private text. Recheck the immutable consent/snapshot and current retention.
    result = db.execute(text(f"""UPDATE exam_session_videos v
        SET generated_transcript = :transcript, transcript_status = 'completed',
            transcript_completed_at = clock_timestamp(), transcript_error = NULL,
            transcript_job_token = NULL, transcript_lease_until = NULL
        FROM exam_sessions s WHERE s.id = v.session_id AND {ELIGIBLE}
          AND v.session_id = CAST(:sid AS uuid) AND v.transcript_status = 'processing'
          AND v.transcript_job_token = CAST(:token AS uuid)
          AND v.transcript_lease_until > clock_timestamp()"""),
        {'sid': sid, 'token': token, 'transcript': transcript})
    db.commit()
    return result.rowcount == 1


def fail_job(db, sid, token, message='Speech transcription failed. An administrator can retry it.'):
    # Only fixed application messages, never decoder/model/DB exception text.
    db.execute(text("""UPDATE exam_session_videos SET transcript_status = 'failed',
        transcript_error = :message, transcript_job_token = NULL,
        transcript_lease_until = clock_timestamp() + interval '30 seconds'
        WHERE session_id = CAST(:sid AS uuid) AND transcript_status = 'processing'
          AND transcript_job_token = CAST(:token AS uuid)"""),
        {'sid': sid, 'token': token, 'message': message})
    db.commit()


def process_job(sid, token, config):
    sid, token = str(UUID(sid)), str(UUID(token))
    db = open_session()
    try:
        job = read_job(db, sid, token)
        db.rollback()  # Do not hold a database transaction during decoding.
        if not job:
            return False
        if not 0 < job['total_bytes'] <= MAX_RECORDING_BYTES:
            raise ValueError('Invalid recording size.')
        path = _safe_path(_recording_root(write_required=False) / f'{sid}.webm')
        with _private_open(path, os.O_RDONLY) as source:
            if os.fstat(source.fileno()).st_size != job['total_bytes']:
                raise ValueError('Recording size does not match saved metadata.')
            transcript = transcribe(source, load_model(config), config)
        return save_job(db, sid, token, transcript)
    except Exception:
        db.rollback()
        fail_job(db, sid, token)
        return False
    finally:
        db.close()


def run_one(config):
    db = open_session()
    try:
        job = claim_job(db, config)
    finally:
        db.close()
    if not job:
        return False
    sid, token = job
    try:
        # Separate process bounds native decoder/model execution. Private model
        # output is discarded and never enters logs or a web request.
        result = subprocess.run([sys.executable, '-m', 'app.transcription_worker',
            '--job', sid, '--lease', token], timeout=config.timeout,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        if result.returncode == 0:
            return True
    except (subprocess.TimeoutExpired, OSError):
        pass
    db = open_session()
    try:
        fail_job(db, sid, token, 'Speech transcription stopped or exceeded its processing time limit.')
    finally:
        db.close()
    return True


def retry_failed(db):
    result = db.execute(text(f"""UPDATE exam_session_videos v SET transcript_status = 'queued',
        transcript_attempts = 0, transcript_error = NULL, transcript_job_token = NULL,
        transcript_lease_until = NULL FROM exam_sessions s
        WHERE s.id = v.session_id AND {ELIGIBLE} AND v.transcript_status = 'failed'"""))
    db.commit()
    return result.rowcount


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once', action='store_true', help='Process at most one eligible recording.')
    parser.add_argument('--check', action='store_true', help='Test synthetic audio decoding and load the local model.')
    parser.add_argument('--retry-failed', action='store_true', help='Explicitly requeue eligible failed jobs and exit.')
    parser.add_argument('--job', type=UUID, help=argparse.SUPPRESS)
    parser.add_argument('--lease', type=UUID, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if bool(args.job) != bool(args.lease):
        parser.error('--job and --lease must be supplied together')
    try:
        config = configuration()
        if find_spec('faster_whisper') is None:
            raise ValueError('Install backend/requirements-transcription.txt in the worker environment.')
        if args.check:
            check_audio_decoder()
            load_model(config)
            print('Synthetic audio decoder and local offline speech model loaded successfully.')
            return 0
        if args.job:
            return 0 if process_job(str(args.job), str(args.lease), config) else 1
        if args.retry_failed:
            db = open_session()
            try:
                count = retry_failed(db)
            finally:
                db.close()
            print(f'Eligible failed speech transcripts queued: {count}')
            return 0
        while True:
            processed = run_one(config)
            if args.once:
                print('One speech transcript job processed.' if processed else 'No eligible speech transcript jobs.')
                return 0
            if not processed:
                time.sleep(5)
    except ValueError as error:
        # Only configuration errors above are allowed to reach this boundary.
        # Model libraries can raise ValueError containing private or local data.
        print('Transcription configuration or model validation failed. Check the local model and worker settings.', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    except Exception:
        print('Transcription worker stopped. Check database schema and worker configuration.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
