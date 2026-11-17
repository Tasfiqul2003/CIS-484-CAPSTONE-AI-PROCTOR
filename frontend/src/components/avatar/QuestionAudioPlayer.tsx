import { useEffect, useRef, useState } from 'react';
import type { MediaEventKind } from '../media/mediaTimeline';

type Asset = { asset_id: string; interaction_id: string; audio_url: string;
  content_sha256: string; duration_seconds: number; status: string };
type Props = { sessionId: string; token: string; sequence: number; disabled: boolean;
  speed: number; volume: number; onBusy: (busy: boolean) => void;
  onState: (state: 'Idle' | 'Speaking' | 'Error') => void;
  beforePlay: () => void;
  onObservation?: (kind: MediaEventKind, sequence: number, assetId?: string) => Promise<unknown> };

/** Saved audio is generated once per approved revision/configuration and replayed verbatim. */
export default function QuestionAudioPlayer(props: Props) {
  const [available, setAvailable] = useState(false);
  const [checkingAvailability, setCheckingAvailability] = useState(true);
  const [availabilityRetry, setAvailabilityRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Checking saved question audio…');
  const player = useRef<HTMLAudioElement>(null);
  const active = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const asset = useRef<Asset | null>(null);
  const objectUrl = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const playback = useRef<{ generation: number; sequence: number; assetId: string } | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;

  function observe(kind: MediaEventKind, id?: string, sequence = callbacks.current.sequence) {
    const generation = active.current;
    void callbacks.current.onObservation?.(kind, sequence, id)
      .catch(() => {
        if (generation === active.current && sequence === callbacks.current.sequence) {
          setError('The playback observation could not be saved. The exam recording is separate.');
        }
      });
  }
  function stop(interrupted = false) {
    active.current++;
    operation.current?.abort(); operation.current = null;
    if (player.current && !player.current.paused) {
      player.current.pause();
      const previous = playback.current;
      if (interrupted && previous) observe('question_audio_failed', previous.assetId, previous.sequence);
    }
    playback.current = null;
    setLoading(false); setPlaying(false);
    callbacks.current.onBusy(false); callbacks.current.onState('Idle');
  }

  useEffect(() => {
    stop(true); asset.current = null; requestId.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    if (player.current) { player.current.removeAttribute('src'); player.current.load(); }
    setAvailable(false); setCheckingAvailability(true); setError(''); setStatus('Checking saved question audio…');
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => {
      controller.abort();
      if (!disposed) {
        setAvailable(false); setCheckingAvailability(false);
        setStatus('Saved question audio is unavailable because its availability check timed out. You can retry or read the question text.');
      }
    }, 5000);
    void fetch(`/api/exam/sessions/${encodeURIComponent(props.sessionId)}/speech/capabilities`, {
      headers: { Authorization: `Bearer ${props.token}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (disposed || controller.signal.aborted) return;
      setAvailable(value?.synthesis?.available === true);
      setStatus(value?.synthesis?.available === true
        ? 'Saved question audio is available. Select Play saved question audio to generate and listen.'
        : 'Saved question audio is unavailable. Read the question text or use the separately labeled browser read-aloud.');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('Saved question audio is unavailable. The question remains readable.');
    }).finally(() => { clearTimeout(timeout); if (!disposed) setCheckingAvailability(false); });
    return () => { disposed = true; controller.abort(); stop(true);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); objectUrl.current = null; };
  }, [props.sessionId, props.token, props.sequence, props.speed, availabilityRetry]);

  useEffect(() => { if (props.disabled) stop(true); }, [props.disabled]);
  useEffect(() => { if (player.current) player.current.volume = props.volume / 100; }, [props.volume]);

  async function play() {
    if (props.disabled || loading || props.volume === 0) return;
    stop(); callbacks.current.beforePlay();
    const generation = active.current;
    const controller = new AbortController(); operation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    setLoading(true); setError(''); callbacks.current.onBusy(true);
    try {
      if (!asset.current) {
        requestId.current ??= crypto.randomUUID();
        const response = await fetch(`/api/exam/sessions/${encodeURIComponent(props.sessionId)}/question-audio`, {
          method: 'POST', headers: { Authorization: `Bearer ${props.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence_num: props.sequence, request_id: requestId.current }), signal: controller.signal,
        });
        const value = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : 'Saved question audio is unavailable. Use the question text.');
        const prefix = `/api/exam/sessions/${encodeURIComponent(props.sessionId)}/question-audio/`;
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (value.status !== 'ready' || !uuid.test(value.asset_id) || !uuid.test(value.interaction_id)
            || typeof value.audio_url !== 'string' || value.audio_url !== prefix + value.asset_id
            || !/^[0-9a-f]{64}$/.test(value.content_sha256) || !(value.duration_seconds > 0 && value.duration_seconds <= 120)) {
          throw new Error('The saved audio response is invalid. Use the question text.');
        }
        if (generation !== active.current) return;
        asset.current = value;
      }
      if (!objectUrl.current) {
        const currentAsset = asset.current!;
        const response = await fetch(currentAsset.audio_url, {
          headers: { Authorization: `Bearer ${props.token}` }, cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) throw new Error('Saved question audio could not be retrieved. Use the question text.');
        const bytes = await response.arrayBuffer();
        if (generation !== active.current) return;
        if (bytes.byteLength < 44 || bytes.byteLength > 10 * 1024 * 1024) throw new Error('Saved question audio has an invalid size.');
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
          .map(value => value.toString(16).padStart(2, '0')).join('');
        if (generation !== active.current) return;
        if (hash !== currentAsset.content_sha256) throw new Error('Saved question audio failed its integrity check.');
        objectUrl.current = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      }
      if (generation !== active.current || !player.current) return;
      player.current.src = objectUrl.current;
      player.current.volume = callbacks.current.volume / 100;
      playback.current = { generation, sequence: props.sequence, assetId: asset.current!.asset_id };
      await player.current.play();
    } catch (failure) {
      if (generation !== active.current) return;
      setError(controller.signal.aborted ? 'Saved question audio timed out. Try again or read the question text.'
        : failure instanceof Error ? failure.message : 'Saved question audio is unavailable.');
      callbacks.current.onState('Error'); callbacks.current.onBusy(false);
      if (asset.current) observe('question_audio_failed', asset.current.asset_id);
    } finally {
      clearTimeout(timeout);
      if (generation === active.current) { operation.current = null; setLoading(false); }
    }
  }
  return <section aria-label="Saved question audio">
    <p role="status">{status}</p>
    {!available && !checkingAvailability && <button type="button" disabled={props.disabled}
      onClick={() => setAvailabilityRetry(value => value + 1)}>Retry saved audio availability</button>}{' '}
    <button type="button" disabled={!available || props.disabled || loading || props.volume === 0}
      onClick={() => void play()}>{loading ? 'Preparing saved question audio…' : asset.current ? 'Replay saved question audio' : 'Play saved question audio'}</button>{' '}
    {(loading || playing) && <button type="button" onClick={() => stop(true)}>Stop saved audio</button>}
    <audio ref={player} preload="none" aria-label="Saved audio of the current question"
      onPlaying={() => { const current = playback.current;
        if (!current || current.generation !== active.current || current.sequence !== callbacks.current.sequence) return;
        setPlaying(true); callbacks.current.onBusy(true); callbacks.current.onState('Speaking');
        observe('question_audio_started', current.assetId, current.sequence); }}
      onEnded={() => { const current = playback.current;
        if (!current || current.generation !== active.current || current.sequence !== callbacks.current.sequence) return;
        setPlaying(false); callbacks.current.onBusy(false); callbacks.current.onState('Idle');
        observe('question_audio_ended', current.assetId, current.sequence); playback.current = null; }}
      onError={() => { const current = playback.current;
        if (!current || current.generation !== active.current || current.sequence !== callbacks.current.sequence) return;
        setError('This browser cannot play the saved question audio. Use the question text.');
        setPlaying(false); callbacks.current.onBusy(false); callbacks.current.onState('Error');
        observe('question_audio_failed', current.assetId, current.sequence); playback.current = null; }} />
    {error && <p role="alert">{error}</p>}
  </section>;
}
