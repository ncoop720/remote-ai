import type {
  CreateSessionRequest,
  DevAction,
  ProjectInfo,
  StartSessionRequest,
  VisiblePrompt,
} from '../../shared/types';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // not JSON
    }
    throw new Error(message);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const session = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

export const api = {
  projects: () => request<ProjectInfo[]>('GET', '/api/projects'),
  createSession: (project: string, body: CreateSessionRequest) =>
    request<{ id: string }>('POST', `/api/projects/${encodeURIComponent(project)}/sessions`, body),
  start: (id: string, body: StartSessionRequest) => request<void>('POST', `${session(id)}/start`, body),
  stop: (id: string) => request<void>('POST', `${session(id)}/stop`),
  remove: (id: string, force = false) => request<void>('DELETE', `${session(id)}${force ? '?force=1' : ''}`),
  keys: (id: string, keys: string[]) => request<void>('POST', `${session(id)}/keys`, { keys }),
  text: (id: string, text: string, submit = true) => request<void>('POST', `${session(id)}/text`, { text, submit }),
  prompt: (id: string) => request<{ prompt: VisiblePrompt | null }>('GET', `${session(id)}/prompt`),
  answer: (id: string, key: string) => request<void>('POST', `${session(id)}/answer`, { key }),
  dev: (id: string, action: DevAction, name?: string) =>
    request<void>('POST', `${session(id)}/dev/${action}${name ? `?name=${encodeURIComponent(name)}` : ''}`),
  logsUrl: (id: string, name: string) => `${session(id)}/logs/${encodeURIComponent(name)}`,
  pushInfo: () => request<{ publicKey: string; subscriptions: number }>('GET', '/api/push'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<{ ok: boolean }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => request<void>('POST', '/api/push/unsubscribe', { endpoint }),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
