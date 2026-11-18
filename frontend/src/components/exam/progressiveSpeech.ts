import type { AvatarClip } from '../avatar/avatarService';
export async function progressiveSpeech(produce: (push: (clip: AvatarClip) => Promise<void>, producerSignal: AbortSignal) => Promise<void>,
  play: (clip: AvatarClip) => Promise<void>, signal: AbortSignal): Promise<void> {
  const local = new AbortController();
  const queue: AvatarClip[] = []; let done = false, error: unknown, count = 0;
  let notify = () => {}; const wake = () => notify();
  const wait = () => new Promise<void>(resolve => { notify = resolve; if (signal.aborted) resolve(); });
  const abort = () => { local.abort(); wake(); }; signal.addEventListener('abort', abort);
  const check = () => { if (signal.aborted || local.signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };
  const producer = produce(async clip => {
    while (queue.length >= 2) { check(); await wait(); }
    check(); queue.push(clip); count++; wake();
  }, local.signal).catch(failure => { error = failure; }).finally(() => { done = true; wake(); });
  try {
    for (;;) {
      check(); if (error) throw error;
      const clip = queue.shift(); wake();
      if (clip) { await play(clip); continue; }
      if (done) break;
      await wait();
    }
    await producer; check(); if (error) throw error;
    if (!count) throw new Error('The talking examiner returned no speech.');
  } finally { local.abort(); wake(); signal.removeEventListener('abort', abort); wake(); }
}
