import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, errorMessage } from './api';
import type { ProjectInfo, ServerEvent } from '../../shared/types';

/** Projects and sessions, kept live by the server's event stream. */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    inflight.current ??= api
      .projects()
      .then((p) => {
        setProjects(p);
        setError(null);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => {
        inflight.current = null;
      });
    return inflight.current;
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => void refresh();
    events.onmessage = (msg) => {
      const event = JSON.parse(msg.data as string) as ServerEvent;
      if (event.type === 'sessions') {
        void refresh();
      } else if (event.type === 'status') {
        setProjects((ps) =>
          ps?.map((p) => ({
            ...p,
            sessions: p.sessions.map((s) =>
              s.id === event.sessionId && s.running ? { ...s, status: event.status } : s,
            ),
          })) ?? ps,
        );
      }
    };
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [refresh]);

  return { projects, error, refresh };
}

export type Route =
  | { name: 'home' }
  | { name: 'setup' }
  | { name: 'session'; id: string }
  | { name: 'new'; project?: string };

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 's' && parts[1]) return { name: 'session', id: parts[1] };
  if (parts[0] === 'new') return { name: 'new', project: parts[1] || undefined };
  if (parts[0] === 'setup') return { name: 'setup' };
  return { name: 'home' };
}

function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export const routes = {
  home: () => '#/',
  setup: () => '#/setup',
  session: (id: string) => `#/s/${encodeURIComponent(id)}`,
  newSession: (project?: string) => (project ? `#/new/${encodeURIComponent(project)}` : '#/new'),
};

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
