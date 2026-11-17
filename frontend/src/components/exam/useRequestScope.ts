import { useCallback, useEffect, useRef } from 'react';
import { abortable } from './abortable';

export type RequestScope = { owner: string; generation: number };

/** Requests and their UI continuations belong to one selected exam only. */
export function useRequestScope(owner: string) {
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const generation = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const capture = useCallback(() => ({ owner, generation: generation.current }), [owner]);
  const isCurrent = useCallback((scope: RequestScope) => scope.owner === currentOwner.current
    && scope.generation === generation.current, []);
  useEffect(() => {
    generation.current++;
    return () => {
      generation.current++;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, [owner]);
  const json = useCallback(async <T,>(scope: RequestScope, url: string, init?: RequestInit,
    timeoutMs = 30000): Promise<T> => {
    if (!isCurrent(scope)) throw new DOMException('The selected exam changed.', 'AbortError');
    const controller = new AbortController(); requests.current.add(controller);
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await abortable((async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!isCurrent(scope)) throw new DOMException('The selected exam changed.', 'AbortError');
        if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The exam request failed.');
        return body as T;
      })(), controller.signal);
      if (!isCurrent(scope)) throw new DOMException('The selected exam changed.', 'AbortError');
      return result;
    } finally {
      clearTimeout(deadline); requests.current.delete(controller);
    }
  }, [isCurrent]);
  return { capture, isCurrent, json };
}
