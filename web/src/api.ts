import type {
  AuthInfo,
  CreateSessionRequest,
  DeviceInfo,
  DevAction,
  PairingCode,
  PreviewAccess,
  ProjectInfo,
  RemoteInfo,
  SetupInfo,
  StartSessionRequest,
  UpdateResult,
  VersionInfo,
  VisiblePrompt,
} from '../../shared/types';

export type { UpdateResult, VersionInfo };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && url !== '/api/login' && url !== '/api/pair') window.dispatchEvent(new Event('ra-login-required'));
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
  /** Set up with Claude: the agent writes .remote-ai.json; it starts if it wasn't running. */
  configureDev: (id: string) => request<{ started: boolean }>('POST', `${session(id)}/dev/configure`),
  logsUrl: (id: string, name: string) => `${session(id)}/logs/${encodeURIComponent(name)}`,
  pushInfo: () => request<{ publicKey: string; subscriptions: number }>('GET', '/api/push'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<{ ok: boolean }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => request<void>('POST', '/api/push/unsubscribe', { endpoint }),
  auth: () => request<AuthInfo>('GET', '/api/auth'),
  login: (password: string) => request<{ ok: boolean }>('POST', '/api/login', { password }),
  logout: () => request<{ ok: boolean }>('POST', '/api/logout'),
  version: (fetchUpstream = false) => request<VersionInfo>('GET', `/api/version${fetchUpstream ? '?fetch=1' : ''}`),
  update: () => request<UpdateResult>('POST', '/api/update'),
  setup: () => request<SetupInfo>('GET', '/api/setup'),
  /** Starts the agent's installer or sign-in in a terminal; returns the terminal to show. */
  agentTask: (agent: string, task: 'install' | 'signin') =>
    request<{ session: string; name: string }>('POST', `/api/agents/${encodeURIComponent(agent)}/${task}`),
  addProject: (path: string) => request<{ name: string }>('POST', '/api/projects', { path }),
  pair: (code: string) => request<{ device: DeviceInfo }>('POST', '/api/pair', { code }),
  handoff: (code: string) => request<{ device: DeviceInfo }>('POST', '/api/pair/handoff', { code }),
  newPairingCode: () => request<PairingCode>('POST', '/api/pair/new'),
  devices: () => request<DeviceInfo[]>('GET', '/api/devices'),
  removeDevice: (id: string) => request<void>('DELETE', `/api/devices/${encodeURIComponent(id)}`),
  remote: () => request<RemoteInfo>('GET', '/api/remote'),
  preview: () => request<PreviewAccess>('GET', '/api/preview'),
  setRemote: (body: { wifi?: boolean; tailscale?: boolean }) => request<RemoteInfo>('POST', '/api/remote', body),
  tailscaleLogout: () => request<void>('POST', '/api/remote/tailscale/logout'),
  removeProject: (name: string) => request<void>('DELETE', `/api/projects/${encodeURIComponent(name)}`),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
