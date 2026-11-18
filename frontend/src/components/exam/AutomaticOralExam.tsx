import { useCallback, useEffect, useRef, useState } from 'react';
import ExamStageAvatar from '../avatar/ExamStageAvatar';
import { loadSessionPresentation, saveSessionPresentation, type SessionPresentation } from '../avatar/sessionPresentation';
import { streamAvatarSpeech, fetchExaminerIdle, type AvatarClip } from '../avatar/avatarService';
import { isRepeatRequest, isClarifyRequest } from '../avatar/voiceCommands';
import { loadAssistance, requestAssistance, completeAssistance } from '../avatar/sessionAssistance';
import type { StudentPreferences } from '../student-settings/studentSettings';
import type { ExamTiming } from '../../pages/student/examTiming';
import type { AnswerMetadata } from '../../pages/student/answerSubmission';
import { prepareSpeechAudio } from './speechWave';
import { readSpeechDraft } from './speechDraft';
import { captureOralAnswer } from './oralCapture';
import { playExaminerAudio } from './playExaminerAudio';
import { abortable } from './abortable';
import './automatic-oral-exam.css';

type HeardTurn = { id: string; sequence: number; text: string; status: string };
const CAPTIONS_KEY = 'oralexam_captions_enabled';

type Phase = 'countdown' | 'preparing' | 'audio_ready' | 'speaking' | 'listening' | 'processing' | 'submitting' | 'paused' | 'error';
type Props = {
  sessionId: string; token: string; sequence: number; question: string;
  disabled: boolean; flashhead: boolean; poster?: string; stream: MediaStream | null;
  preferences: StudentPreferences | null;
  onAnswer: (text: string, metadata: AnswerMetadata) => void;
  onTiming: (timing: ExamTiming) => void;
  onMediaElement: (element: HTMLVideoElement | null) => void;
  onResumeAudio?: () => Promise<void>;
};
const LINES = {
  retry: 'I could not make out your answer. Take your time and try again, or say move on.',
  silence: 'Take a breath and answer naturally when you are ready. You can also say move on.',
  move_on: 'Let us move on to the next question.',
  assistance_unavailable: 'That assistance is not available for this question. Please answer in your own words, or say move on.',
};
const UNANSWERED = '[System: No intelligible spoken answer captured.]';
const abortError = () => new DOMException('Cancelled', 'AbortError');
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** A question (including a server-selected follow-up) owns exactly one cancellable oral loop. */
export default function AutomaticOralExam(props: Props) {
  const { sessionId, token, sequence, question, disabled, flashhead, poster = '' } = props;
  const [presentation, setPresentation] = useState<SessionPresentation | null>(null);
  const [environmentError, setEnvironmentError] = useState('');
  const [environmentStatus, setEnvironmentStatus] = useState('');
  const [environmentSaving, setEnvironmentSaving] = useState(false);
  const [environmentReload, setEnvironmentReload] = useState(0);
  const environmentGeneration = useRef(0);
  const environmentRequest = useRef(0);
  const preferences = presentation?.preferences ?? props.preferences;
  const latest = useRef(props); latest.current = { ...props, preferences };
  useEffect(() => {
    const controller = new AbortController();
    environmentGeneration.current += 1;
    setPresentation(null); setEnvironmentError(''); setEnvironmentStatus(''); setEnvironmentSaving(false);
    void loadSessionPresentation(sessionId, token, controller.signal).then(value => {
      if (!controller.signal.aborted) setPresentation(value);
    }).catch(() => {
      if (!controller.signal.aborted) setEnvironmentError('Environment settings are unavailable. Your exam can continue.');
    });
    return () => { controller.abort(); environmentGeneration.current += 1; };
  }, [sessionId, token, environmentReload]);
  async function changeEnvironment(background: string) {
    if (!presentation || environmentRequest.current || !presentation.policy.allowBackground ||
        !presentation.policy.backgroundChoices.some(choice => choice.id === background)) return;
    const generation = environmentGeneration.current;
    environmentRequest.current = generation;
    setEnvironmentSaving(true); setEnvironmentError(''); setEnvironmentStatus('');
    try {
      const saved = await saveSessionPresentation(sessionId, token, { ...presentation.preferences, background });
      if (generation === environmentGeneration.current) {
        setPresentation(saved); setEnvironmentStatus('Environment saved for this attempt.');
      }
    } catch {
      if (generation === environmentGeneration.current) setEnvironmentError('Environment could not be saved. Your previous environment is still selected. Try again.');
    } finally {
      if (environmentRequest.current === generation) environmentRequest.current = 0;
      if (generation === environmentGeneration.current) setEnvironmentSaving(false);
    }
  }
  const [phase, setPhase] = useState<Phase>('countdown');
  const [countdown, setCountdown] = useState(5);
  const [caption, setCaption] = useState('');
  const [spokenCaption, setSpokenCaption] = useState('');
  const [captionsEnabled, setCaptionsEnabled] = useState(() => {
    try { return localStorage.getItem(CAPTIONS_KEY) !== 'off'; } catch { return true; }
  });
  const [heardTurns, setHeardTurns] = useState<HeardTurn[]>([]);
  const heardLog = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (heardLog.current) heardLog.current.scrollTop = heardLog.current.scrollHeight; }, [heardTurns]);
  useEffect(() => { setHeardTurns([]); }, [sessionId]);
  const toggleCaptions = () => setCaptionsEnabled(enabled => {
    const next = !enabled;
    try { localStorage.setItem(CAPTIONS_KEY, next ? 'on' : 'off'); } catch { /* Captions still work for this page. */ }
    return next;
  });
  const [error, setError] = useState('');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const resumePlayback = useRef<(() => void) | null>(null);
  const [meter, setMeter] = useState(0);
  const [retry, setRetry] = useState(0);
  const [idle, setIdle] = useState('');
  const media = useRef<HTMLVideoElement | null>(null);
  const begun = useRef(false);
  const attach = useCallback((element: HTMLVideoElement | null) => {
    media.current = element; latest.current.onMediaElement(element);
  }, []);

  useEffect(() => {
    setIdle('');
    if (!flashhead) return;
    const controller = new AbortController();
    void fetchExaminerIdle(sessionId, token, controller.signal).then(url => { if (!controller.signal.aborted) setIdle(url); });
    return () => controller.abort();
  }, [sessionId, token, flashhead]);

  useEffect(() => {
    if (disabled) { setPhase('paused'); return; }
    const controller = new AbortController();
    const signal = controller.signal;
    const base = `/api/exam/sessions/${encodeURIComponent(sessionId)}/speech`;
    const headers = { Authorization: `Bearer ${token}` };
    const check = () => { if (signal.aborted) throw abortError(); };
    let assistanceId: string | null = null;
    const heard = (id: string, text: string, status: string) => {
      check();
      setHeardTurns(current => [...current, { id, sequence, text, status }].slice(-6));
    };
    const heardStatus = (id: string, status: string) => {
      check();
      setHeardTurns(current => current.map(turn => turn.id === id ? { ...turn, status } : turn));
    };
    const request = async (path: string, body?: unknown, requestSignal = signal) => {
      const response = await fetch(`${base}/${path}`, { headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: requestSignal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.detail === 'string' ? data.detail : data.detail?.message || 'The examiner service is unavailable.');
      }
      return response;
    };
    const play = async (url: string) => {
      const element = media.current;
      if (!element) throw new Error('Examiner audio is unavailable.');
      check(); setPhase('audio_ready'); setPlaybackNotice('Audio is ready. Starting browser playback…');
      element.volume = (latest.current.preferences?.volume ?? 70) / 100;
      await playExaminerAudio(element, url, signal, {
        resumeAudio: () => latest.current.onResumeAudio?.() ?? Promise.resolve(),
        onReady: action => { resumePlayback.current = action; },
        onStarted: () => { if (!signal.aborted) { setPlaybackNotice(''); setPhase('speaking'); } },
        onBlocked: message => { if (!signal.aborted) setPlaybackNotice(message); },
      });
    };
    const say = async (kind: 'question' | keyof typeof LINES | 'assistance', text?: string) => {
      check(); setPhase('preparing');
      const words = kind === 'question' ? question : kind === 'assistance' ? text! : LINES[kind];
      setCaption(words); setSpokenCaption(words);
      if (flashhead) {
        // Keep audio and matching face motions together; never listen during playback.
        const clips: AvatarClip[] = [];
        await streamAvatarSpeech(sessionId, token, words, clip => clips.push(clip), signal);
        check(); if (!clips.length) throw new Error('The talking examiner returned no speech.');
        for (const clip of clips) { check(); setSpokenCaption(clip.text || words); await play(clip.url); }
      } else {
        const synthesis = new AbortController();
        const cancel = () => synthesis.abort();
        signal.addEventListener('abort', cancel, { once: true });
        const deadline = window.setTimeout(cancel, 45000);
        let blob: Blob;
        try {
          const response = await abortable(request('utterance', { sequence_num: sequence, request_id: crypto.randomUUID(), kind,
            ...(kind === 'assistance' ? { text } : {}) }, synthesis.signal), synthesis.signal);
          blob = await abortable(response.blob(), synthesis.signal);
        } catch (failure) {
          if (synthesis.signal.aborted && !signal.aborted) throw new Error('Examiner audio generation timed out. Resume the spoken exam to try again.');
          throw failure;
        } finally { window.clearTimeout(deadline); signal.removeEventListener('abort', cancel); }
        check();
        const url = URL.createObjectURL(blob);
        try { check(); await play(url); } finally { URL.revokeObjectURL(url); }
      }
      check();
    };
    const assist = async (action: 'repeat' | 'clarification') => {
      setPhase('processing');
      const state = await loadAssistance(sessionId, token, sequence, signal); check();
      const allowance = state.actions[action];
      if (!allowance || allowance.remaining === 0) { await say('assistance_unavailable'); return; }
      assistanceId = crypto.randomUUID();
      const result = await requestAssistance(sessionId, token, sequence, action, assistanceId);
      if (signal.aborted) {
        void completeAssistance(sessionId, token, sequence, assistanceId).catch(() => undefined);
        throw abortError();
      }
      latest.current.onTiming(result);
      if (result.status !== 'succeeded' || !result.text) throw new Error('Question assistance could not be completed.');
      await say('assistance', result.text);
      const completed = await completeAssistance(sessionId, token, sequence, assistanceId);
      check(); latest.current.onTiming(completed); assistanceId = null;
    };
    const run = async () => {
      setError('');
      // Check native speech independently of the avatar service. Never silently type or skip a provider failure.
      const capabilities = await (await request('capabilities')).json(); check();
      if (!capabilities.transcription?.available || (!flashhead && !capabilities.synthesis?.available))
        throw new Error('Speech input and examiner audio must be available before the spoken exam can continue.');
      if (!begun.current) {
        setPhase('countdown');
        for (let seconds = 5; seconds > 0; seconds--) { setCountdown(seconds); await delay(1000, signal); }
        begun.current = true;
      }
      await say('question');
      let attempts = 0;
      while (!signal.aborted) {
        setPhase('listening'); setCaption('Listening. Answer naturally; pause for three seconds when you finish.');
        const blob = await captureOralAnswer(latest.current.stream, signal, setMeter); check();
        if (!blob) {
          heard(crypto.randomUUID(), 'No speech detected.', 'No transcript');
          attempts++;
          if (attempts <= 2) { await say('silence'); continue; }
        } else {
          setPhase('processing'); setCaption('The examiner is processing your response.');
          const id = crypto.randomUUID();
          const audio = await prepareSpeechAudio(blob, capabilities.transcription.accepted_mime_types ?? []); check();
          const response = await fetch(`${base}/transcribe?sequence_num=${sequence}&request_id=${id}`, {
            method: 'POST', headers: { ...headers, 'Content-Type': audio.type }, body: audio, signal });
          check();
          if (!response.ok) {
            const failure = await response.json().catch(() => ({}));
            if (failure.detail?.code !== 'empty_transcript') throw new Error(failure.detail?.message || 'Speech transcription failed.');
            heard(id, 'No words could be recognized.', 'No transcript');
            attempts++;
            if (attempts <= 2) { await say('retry'); continue; }
          } else {
            const draft = readSpeechDraft(await response.json(), id, sequence); check();
            heard(id, draft.text, 'Processing');
            if (isRepeatRequest(draft.text)) { heardStatus(id, 'Repeat requested'); await assist('repeat'); continue; }
            if (isClarifyRequest(draft.text)) { heardStatus(id, 'Clarification requested'); await assist('clarification'); continue; }
            if (!/^(please )?(move on|skip( this( question)?)?|next question)( please)?[.!?]?$/i.test(draft.text.trim())) {
              const assessment = await (await request('assess', { sequence_num: sequence, request_id: id,
                transcript_draft_id: draft.transcript_draft_id, machine_draft: draft.text,
                transcript_receipt: draft.transcript_receipt })).json(); check();
              if (assessment.request_id !== id || assessment.sequence_num !== sequence
                  || !['clear', 'unclear'].includes(assessment.decision)) throw new Error('The answer check returned an invalid result.');
              if (assessment.decision === 'clear') {
                heardStatus(id, 'Answer recognized');
                setPhase('submitting');
                latest.current.onAnswer(draft.text, { input_source: 'automatic_transcript',
                  transcript_draft_id: draft.transcript_draft_id, machine_draft: draft.text, transcript_receipt: draft.transcript_receipt });
                return;
              }
              heardStatus(id, 'Unclear — please try again');
              attempts++;
              if (attempts <= 2) { await say('retry'); continue; }
            } else heardStatus(id, 'Move on requested');
          }
        }
        await say('move_on'); setPhase('submitting');
        latest.current.onAnswer(UNANSWERED, { input_source: 'unanswered_voice' }); return;
      }
    };
    // Network/provider waits are bounded even when a browser/transport never settles.
    const deadline = window.setTimeout(() => {
      controller.abort(); setPhase('error'); setError('The spoken turn timed out. Resume the spoken exam or contact your professor.');
    }, 12 * 60 * 1000);
    void run().catch(failure => {
      if (!signal.aborted) { setPhase('error'); setError(failure instanceof Error ? failure.message : 'The spoken exam is unavailable.'); }
    }).finally(() => clearTimeout(deadline));
    return () => {
      controller.abort(); clearTimeout(deadline); media.current?.pause();
      if (assistanceId) void completeAssistance(sessionId, token, sequence, assistanceId).catch(() => undefined);
    };
  }, [sessionId, token, sequence, question, disabled, flashhead, retry]);

  return <section className="automatic-oral-exam" data-phase={phase} aria-label="Automatic oral examiner">
    <div className="automatic-caption-controls">
      <button type="button" className="automatic-captions-toggle" aria-pressed={captionsEnabled}
        aria-label="Examiner captions" onClick={toggleCaptions}>Captions {captionsEnabled ? 'on' : 'off'}</button>
    </div>
    <div className="automatic-examiner-stage">
      <ExamStageAvatar avatar={preferences?.avatar} background={preferences?.background}
        customAvatar={presentation?.policy.defaults.customAvatar} customBackground={presentation?.policy.defaults.customBackground}>
      {flashhead && <div className="automatic-examiner-media">
      {(!idle && !poster && phase !== 'speaking') && <span className="automatic-examiner-waiting">Examiner getting ready…</span>}
      {flashhead && idle && phase !== 'speaking' && <video className="automatic-examiner-poster" src={idle} autoPlay loop muted playsInline aria-hidden="true" />}
      {flashhead && !idle && poster && phase !== 'speaking' && <img className="automatic-examiner-poster" src={poster} alt="Examiner" />}
      </div>}
      </ExamStageAvatar>
      <video ref={attach} playsInline preload="auto" className={flashhead && phase === 'speaking' ? 'automatic-examiner-video' : 'automatic-examiner-audio'} />
      {captionsEnabled && phase === 'speaking' && spokenCaption && <div className="automatic-caption-overlay"
        role="region" aria-label="Examiner captions overlay" aria-live="polite" aria-atomic="true">
        <span>{spokenCaption}</span>
      </div>}
    </div>
    <p className="automatic-exam-phase" role="status">{phase === 'countdown' ? `Beginning in ${countdown}`
      : phase === 'preparing' ? 'Generating examiner audio…' : phase === 'audio_ready' ? 'Audio ready — waiting for browser playback' : phase === 'speaking' ? 'Examiner speaking'
      : phase === 'listening' ? 'Listening' : phase === 'processing' ? 'Thinking'
      : phase === 'submitting' ? 'Saving your answer and preparing the next question…'
      : phase === 'paused' ? 'Exam interaction paused' : 'Spoken exam needs attention'}</p>
    {phase === 'audio_ready' && <div className="automatic-playback-recovery" role="status">
      <p>{playbackNotice}</p>
      <button type="button" onClick={() => resumePlayback.current?.()}>Play examiner audio</button>
    </div>}
    {phase === 'countdown' ? <p>Relax, take a breath, and answer naturally in your own words.</p>
      : (phase === 'listening' || phase === 'processing') && <p aria-live="polite">{caption}</p>}
    {phase === 'listening' && <div className="automatic-listening-meter" aria-hidden="true"><span style={{ transform: `scaleX(${meter})` }} /></div>}
    <section className="automatic-heard-panel" aria-label="What the examiner heard">
      <h2>What the examiner heard</h2>
      <p className="automatic-heard-help">Updates after each spoken turn. Speech recognition may make mistakes.</p>
      <div ref={heardLog} role="log" aria-live="polite" aria-relevant="additions text" aria-label="Recognized speech">
        {heardTurns.length ? <ol>{heardTurns.map(turn => <li key={turn.id}>
          <div className="automatic-heard-meta"><span>Question {turn.sequence}</span><span>{turn.status}</span></div>
          <p>{turn.text}</p>
        </li>)}</ol> : <p className="automatic-heard-empty">Your recognized words will appear here after you speak.</p>}
      </div>
    </section>
    <div className="automatic-environment-controls">
      {presentation && (presentation.policy.allowBackground ? <label>Exam environment
        <select aria-label="Exam environment" value={presentation.preferences.background} disabled={environmentSaving}
          onChange={event => void changeEnvironment(event.currentTarget.value)}>
          {presentation.policy.backgroundChoices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label> : <p>Your professor has fixed the exam environment.</p>)}
      {environmentStatus && <p role="status">{environmentStatus}</p>}
      {environmentError && <p role="alert">{environmentError} {!presentation && <button type="button"
        onClick={() => setEnvironmentReload(value => value + 1)}>Reload environment settings</button>}</p>}
    </div>
    {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Resume spoken exam</button></div>}
  </section>;
}
