import { EventEmitter } from 'node:events';
import type { SessionStatus } from '../../shared/types.js';

export const INITIAL_STATUS: SessionStatus = { state: 'unknown', updatedAt: 0 };

/** In-memory status per session id, moved by each agent's events. Emits `change` with (sessionId, next, prev). */
export class StatusStore extends EventEmitter {
  private readonly statuses = new Map<string, SessionStatus>();

  get(sessionId: string): SessionStatus {
    return this.statuses.get(sessionId) ?? INITIAL_STATUS;
  }

  /** Apply a pure transition; nothing is emitted when it returns the same status. */
  update(sessionId: string, reduce: (prev: SessionStatus) => SessionStatus): void {
    const prev = this.get(sessionId);
    const next = reduce(prev);
    if (next === prev) return;
    this.statuses.set(sessionId, next);
    this.emit('change', sessionId, next, prev);
  }

  reset(sessionId: string): void {
    const prev = this.get(sessionId);
    this.statuses.delete(sessionId);
    this.emit('change', sessionId, INITIAL_STATUS, prev);
  }
}
