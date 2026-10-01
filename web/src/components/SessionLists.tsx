import { useState } from 'react';
import { routes } from '../hooks';
import { groupOf, subtitle, type StatusGroup } from '../status';
import type { ProjectInfo, SessionInfo } from '../../../shared/types';
import { ChevronRight, Folder, Plus } from './icons';
import { NotificationsButton } from './NotificationsButton';
import { UpdatePanel } from './UpdatePanel';
import { StatusDot } from './StatusDot';

/** Desktop sidebar: sessions grouped by project. */
export function Sidebar({ projects, selectedId }: { projects: ProjectInfo[]; selectedId?: string }) {
  return (
    <nav className="sidebar" aria-label="Projects and sessions">
      <div className="sidebar-head">
        <span className="brand">remote-ai</span>
        <div className="row">
          <NotificationsButton />
          <a className="btn btn-small" href={routes.newSession()}>
            <Plus size={14} /> New
          </a>
        </div>
      </div>
      <div className="sidebar-projects">
        {projects.map((p) => (
          <div key={p.name} className="sidebar-project">
            <div className="sidebar-project-head">
              <span>
                <Folder size={15} /> {p.name}
              </span>
              <a className="icon-btn icon-btn-small" href={routes.newSession(p.name)} aria-label={`New session in ${p.name}`}>
                <Plus size={15} />
              </a>
            </div>
            {p.sessions.map((s) => (
              <a
                key={s.id}
                href={routes.session(s.id)}
                className={`sidebar-row${s.id === selectedId ? ' selected' : ''}`}
                aria-current={s.id === selectedId ? 'page' : undefined}
              >
                <StatusDot state={s.status.state} />
                <span className="mono grow ellipsis">{s.branch ?? 'detached'}</span>
                {s.port && s.running && <span className="port">:{s.port}</span>}
              </a>
            ))}
          </div>
        ))}
        {projects.length === 0 && <EmptyProjects />}
      </div>
      <div className="sidebar-links">
        <a className="sidebar-link" href={routes.connect()}>
          Connect a phone
        </a>
        <a className="sidebar-link" href={routes.setup()}>
          Projects &amp; setup
        </a>
      </div>
      <UpdatePanel />
    </nav>
  );
}

const GROUPS: { id: StatusGroup; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'working', label: 'Working' },
  { id: 'idle', label: 'Idle' },
  { id: 'stopped', label: 'Not running' },
];

/** Phone home screen: sessions grouped by what they need from you, filterable by project. */
export function MobileSessionList({ projects }: { projects: ProjectInfo[] }) {
  const [filter, setFilter] = useState<string | null>(null);
  const all = projects.flatMap((p) => p.sessions).filter((s) => !filter || s.project === filter);

  return (
    <div className="mobile-list">
      <header className="mobile-list-head">
        <h1>Sessions</h1>
        <NotificationsButton />
      </header>
      {projects.length > 1 && (
        <div className="chips" role="group" aria-label="Filter by project">
          <button type="button" className="chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>
            All
          </button>
          {projects.map((p) => (
            <button key={p.name} type="button" className="chip" aria-pressed={filter === p.name} onClick={() => setFilter(p.name)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      {projects.length === 0 && <EmptyProjects />}
      {GROUPS.map((g) => {
        const items = all.filter((s) => groupOf(s) === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id} className={`group group-${g.id}`}>
            <h2>
              {g.label} · {items.length}
            </h2>
            <div className="card-list">
              {items.map((s) => (
                <SessionRow key={s.id} session={s} />
              ))}
            </div>
          </section>
        );
      })}
      <a className="sidebar-link" href={routes.setup()}>
        Projects &amp; setup
      </a>
      <UpdatePanel />
      <a className="fab" href={routes.newSession(filter ?? undefined)}>
        <Plus size={18} /> New session
      </a>
    </div>
  );
}

function SessionRow({ session: s }: { session: SessionInfo }) {
  return (
    <a className="session-row" href={routes.session(s.id)}>
      <StatusDot state={s.status.state} />
      <span className="grow session-row-text">
        <span className="mono session-row-branch">{s.branch ?? 'detached'}</span>
        <span className="session-row-sub ellipsis">
          {s.project} · {subtitle(s)}
        </span>
      </span>
      {s.port && s.running && <span className="port">:{s.port}</span>}
      <ChevronRight size={16} />
    </a>
  );
}

function EmptyProjects() {
  return (
    <p className="empty">
      No projects yet. <a href={routes.setup()}>Add a repository</a> to start sessions in it.
    </p>
  );
}
