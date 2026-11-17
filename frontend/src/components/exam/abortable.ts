/** Stop waiting promptly even when a decoder or already queued promise ignores abort. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new DOMException('The request was cancelled.', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    // Attach both continuations even for an already-aborted signal so late
    // failures are consumed and cannot become unhandled rejections.
    work.then(value => { cleanup(); if (!signal.aborted) resolve(value); }, failure => {
      cleanup(); if (!signal.aborted) reject(failure);
    });
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}
