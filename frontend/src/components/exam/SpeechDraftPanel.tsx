import { useEffect, useRef, useState } from 'react';
import { prepareSpeechAudio } from './speechWave';
import { abortable } from './abortable';
import { confirmedTranscript, readSpeechDraft } from './speechDraft';
import type { ConfirmedTranscript, SpeechDraftResponse } from './speechDraft';

type Props = {
  sessionId: string;
  token: string;
  sequence: number;
  stream: MediaStream | null;
  disabled: boolean;
  onDraftConfirmed: (text: string, metadata: ConfirmedTranscript) => void;
  onBusyChange?: (busy: boolean) => void;
};

type SpeechOwner={sessionId:string;token:string;sequence:number};
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export default function SpeechDraft({ sessionId, token, sequence, stream, disabled,
  onDraftConfirmed, onBusyChange }: Props) {
  const [available, setAvailable] = useState(false);
  const [capabilityChecked, setCapabilityChecked] = useState(false);
  const [phase, setPhase] = useState<'ready' | 'capturing' | 'transcribing' | 'review'>('ready');
  const [draft, setDraft] = useState<SpeechDraftResponse | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [applied, setApplied] = useState(false);
  const [capabilityRetry,setCapabilityRetry]=useState(0);
  const [capabilityError,setCapabilityError]=useState('');
  const [capabilityOwner,setCapabilityOwner]=useState<SpeechOwner|null>(null);
  const [draftOwner,setDraftOwner]=useState<SpeechOwner|null>(null);
  const capabilityGeneration=useRef(0);
  const latestOwner=useRef({sessionId,token,sequence});
  latestOwner.current={sessionId,token,sequence};
  const acceptedInputs = useRef<string[]>(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav']);
  const generation = useRef(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;

  function sameOwner(value:SpeechOwner|null) {
    return value?.sessionId===sessionId && value?.token===token && value?.sequence===sequence;
  }
  function isCurrent(current:number) {
    return generation.current===current && sameOwner(latestOwner.current);
  }
  const availableHere=available&&sameOwner(capabilityOwner);
  const draftHere=draft&&sameOwner(draftOwner)?draft:null;

  function cancel() {
    generation.current++;
    request.current?.abort();
    request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (recorder.current?.state === 'recording') recorder.current.stop();
    recorder.current = null;
    // The supplied stream belongs to assessed recording. Never stop its tracks.
    busyCallback.current?.(false);
  }

  useEffect(()=>{
    setAvailable(false);setCapabilityChecked(false);setCapabilityOwner(null);setPhase('ready');setDraft(null);setDraftOwner(null);
    setText('');setError('');setApplied(false);setCapabilityError('');
    return ()=>cancel();
  },[sessionId,token,sequence]);

  useEffect(()=>{
    setAvailable(false);setCapabilityChecked(false);setCapabilityOwner(null);setCapabilityError('');
    const controller=new AbortController();
    const lookup=++capabilityGeneration.current,current=generation.current;
    const deadline=setTimeout(()=>controller.abort(),12000);
    void abortable((async()=>{
      const response=await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/speech/capabilities`,{
        headers:{Authorization:`Bearer ${token}`},signal:controller.signal,
      });
      if(!response.ok)throw new Error('Speech input availability could not be checked. Type your answer or retry.');
      return response.json();
    })(),controller.signal).then(value=>{
      if(!isCurrent(current)||lookup!==capabilityGeneration.current)return;
      const accepted=value?.transcription?.accepted_mime_types;
      acceptedInputs.current=Array.isArray(accepted)
        ?accepted.filter((type:unknown):type is string=>typeof type==='string'&&['audio/webm','audio/ogg','audio/mp4','audio/wav'].includes(type))
        :['audio/webm','audio/ogg','audio/mp4','audio/wav'];
      setAvailable(value?.transcription?.available===true&&acceptedInputs.current.length>0);
      setCapabilityOwner({sessionId,token,sequence});setCapabilityChecked(true);
    }).catch(failure=>{
      if(isCurrent(current)&&lookup===capabilityGeneration.current){
        setAvailable(false);setCapabilityOwner(null);setCapabilityChecked(true);
        setCapabilityError(controller.signal.aborted?'Speech availability check timed out. Type your answer or retry.'
          :failure instanceof Error?failure.message:'Speech availability is unavailable. Type your answer or retry.');
      }
    }).finally(()=>clearTimeout(deadline));
    return()=>{capabilityGeneration.current++;clearTimeout(deadline);controller.abort();};
  },[sessionId,token,sequence,capabilityRetry]);

  useEffect(() => {
    if (disabled && (recorder.current || request.current)) {
      cancel(); setPhase(current => current === 'review' ? current : 'ready');
    }
  }, [disabled]);

  async function transcribe(blob: Blob, current: number) {
    if (!isCurrent(current)) return;
    if (!blob.size || blob.size > MAX_AUDIO_BYTES) {
      setError('The speech draft is empty or too large. Try again or type your answer.');
      setPhase('ready'); busyCallback.current?.(false); return;
    }
    const controller = new AbortController();
    request.current = controller;
    timer.current = setTimeout(() => controller.abort(), 55000);
    setPhase('transcribing');
    const requestId = crypto.randomUUID();
    try {
      const result = await abortable((async () => {
      const prepared = await prepareSpeechAudio(blob, acceptedInputs.current);
      if (!isCurrent(current) || controller.signal.aborted)
        throw new DOMException('Speech preparation was cancelled.', 'AbortError');
      const response = await fetch(`/api/exam/sessions/${encodeURIComponent(sessionId)}/speech/transcribe?sequence_num=${sequence}&request_id=${requestId}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': prepared.type },
        body: prepared, signal: controller.signal,
      });
      if (!response.ok) throw new Error('Transcription could not be completed. Your typed answer is preserved. Try again or type your answer.');
      return readSpeechDraft(await response.json(), requestId, sequence);
      })(), controller.signal);
      if (!isCurrent(current)) return;
      setDraft(result); setDraftOwner({sessionId,token,sequence}); setText(result.text); setApplied(false); setPhase('review');
    } catch (failure) {
      if (isCurrent(current)) {
        setError(controller.signal.aborted ? 'Transcription timed out. Try again or type your answer.'
          : failure instanceof Error ? failure.message : 'Transcription failed. Type your answer.');
        setPhase('ready');
      }
    } finally {
      if (isCurrent(current)) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null; request.current = null; busyCallback.current?.(false);
      }
    }
  }

  function start() {
    if (disabled || !availableHere || !stream || !stream.getAudioTracks().some(track => track.readyState === 'live')) {
      setError('An active permitted microphone stream is required. You can type your answer.'); return;
    }
    cancel(); setError(''); setApplied(false);
    const current = generation.current;
    try {
      if (typeof MediaRecorder === 'undefined') throw new Error('Speech recording is unsupported in this browser. Type your answer.');
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(value => MediaRecorder.isTypeSupported(value));
      if (!mimeType) throw new Error('This browser cannot create a supported speech draft. Type your answer.');
      // Wrap existing audio tracks; this neither acquires nor clones devices.
      const audioStream = new MediaStream(stream.getAudioTracks());
      const capture = new MediaRecorder(audioStream, { mimeType, audioBitsPerSecond: 64000 });
      let chunks: Blob[] = [];
      let bytes = 0;
      capture.ondataavailable = event => {
        if (!isCurrent(current) || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > MAX_AUDIO_BYTES) {
          cancel(); setPhase('ready'); setError('The speech draft exceeded the size limit. Type your answer.'); return;
        }
        chunks.push(event.data);
      };
      capture.onerror = () => {
        if (!isCurrent(current)) return;
        cancel(); setPhase('ready'); setError('Speech draft recording was interrupted. Your typed answer is preserved.');
      };
      capture.onstop = () => {
        if (!isCurrent(current)) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null; recorder.current = null;
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];
        void transcribe(blob, current);
      };
      window.speechSynthesis?.cancel();
      recorder.current = capture;
      capture.start(1000);
      timer.current = setTimeout(() => { if (capture.state === 'recording') capture.stop(); }, 120000);
      setPhase('capturing'); busyCallback.current?.(true);
    } catch (failure) {
      cancel(); setPhase('ready'); setError(failure instanceof Error ? failure.message : 'Speech input is unavailable. Type your answer.');
    }
  }

  const busy = phase === 'capturing' || phase === 'transcribing';
  return <fieldset className="speech-draft" aria-label="Optional speech answer draft" style={{ marginBlock: 16, padding: 12 }}>
    <legend>Optional speech draft</legend>
    <p role="status">{phase === 'capturing' ? 'Recording an answer draft. Stop when you finish; exam time continues.'
      : phase === 'transcribing' ? 'Transcribing your draft. Exam time continues.'
      : !capabilityChecked ? 'Checking speech input availability…'
      : !availableHere ? 'Speech transcription is unavailable. Type your answer below.'
      : 'Record, review and edit a draft, then choose Use reviewed transcript. Submit your answer separately.'}</p>
    <button type="button" onClick={start} disabled={disabled || busy || !availableHere || !stream}>Record speech draft</button>{' '}
    {phase === 'capturing' && <button type="button" onClick={() => recorder.current?.stop()}>Stop and transcribe</button>}{' '}
    {busy && <button type="button" onClick={() => { cancel(); setPhase(draftHere ? 'review' : 'ready'); }}>Cancel speech draft</button>}
    {capabilityError&&<p role="alert">{capabilityError}</p>}
    {capabilityChecked&&!availableHere&&<button type="button" disabled={disabled||busy}
      onClick={()=>setCapabilityRetry(value=>value+1)}>Retry speech availability</button>}
    {draftHere && <div>
      <label htmlFor="review-speech-draft">Review and edit the machine transcript</label>
      <textarea id="review-speech-draft" value={text} maxLength={8000} disabled={disabled || busy}
        style={{ display: 'block', width: '100%', minHeight: 100 }}
        onChange={event => { setText(event.target.value); setApplied(false); }} />
      <button type="button" disabled={disabled || busy || !text.trim()} onClick={() => {
        onDraftConfirmed(text.trim(), confirmedTranscript(draftHere)); setApplied(true);
      }}>Use reviewed transcript</button>
      {applied && <p role="status">Reviewed transcript copied to your answer. Use Submit answer when ready.</p>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
