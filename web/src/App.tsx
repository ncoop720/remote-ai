import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useMediaQuery, useProjects, useRoute } from './hooks';
import { Login } from './components/Login';
import { NewSession } from './components/NewSession';
import { MobileSessionList, Sidebar } from './components/SessionLists';
import { SessionView } from './components/SessionView';
import { setupNeeded, SetupView, useSetup } from './components/SetupView';

const SKIP_KEY = 'ra-setup-skipped';

function readSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

/** Shows the login form when the server has a password and this browser isn't logged in. */
export function App() {
  const [auth, setAuth] = useState<'checking' | 'ok' | 'login'>('checking');

  useEffect(() => {
    api
      .auth()
      .then((a) => setAuth(a.required ? 'login' : 'ok'))
      .catch(() => setAuth('ok'));
    const onRequired = () => setAuth('login');
    window.addEventListener('ra-login-required', onRequired);
    return () => window.removeEventListener('ra-login-required', onRequired);
  }, []);

  if (auth === 'checking') return <div className="splash">Loading…</div>;
  if (auth === 'login') return <Login onDone={() => window.location.reload()} />;
  return <Dashboard />;
}

function Dashboard() {
  const { projects, error, refresh } = useProjects();
  const { setup, refresh: refreshSetup } = useSetup();
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshSetup()]);
  }, [refresh, refreshSetup]);
  const [skipped, setSkipped] = useState(readSkipped);
  const route = useRoute();
  const isDesktop = useMediaQuery('(min-width: 900px)');

  if (!projects) {
    return <div className="splash">{error ? `Can't reach the server: ${error}` : 'Loading…'}</div>;
  }

  // The checklist opens by itself until this computer is ready, unless it was put off.
  const autoSetup = route.name === 'home' && !skipped && setupNeeded(setup, projects);
  const skip = () => {
    try {
      localStorage.setItem(SKIP_KEY, '1');
    } catch {
      // private window: skipped for this visit only
    }
    setSkipped(true);
  };
  const setupView = (route.name === 'setup' || autoSetup) && (
    <SetupView
      projects={projects}
      setup={setup}
      refresh={refreshAll}
      onSkip={autoSetup ? skip : undefined}
    />
  );

  const sessions = projects.flatMap((p) => p.sessions);
  const selected = route.name === 'session' ? sessions.find((s) => s.id === route.id) : undefined;
  const onChanged = () => void refresh();

  const main = selected ? (
    <SessionView key={selected.id} session={selected} isDesktop={isDesktop} onChanged={onChanged} />
  ) : route.name === 'session' ? (
    <div className="empty-main">That session no longer exists.</div>
  ) : null;

  const newSession = route.name === 'new' && (
    <NewSession projects={projects} initialProject={route.project} onCreated={onChanged} />
  );

  if (isDesktop) {
    return (
      <div className="layout-desktop">
        <Sidebar projects={projects} selectedId={selected?.id} />
        <main className="main">{setupView || main || <div className="empty-main">Pick a session, or start a new one.</div>}</main>
        {newSession}
        {error && <div className="toast error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="layout-mobile">
      {setupView || (route.name === 'home' || route.name === 'new' ? <MobileSessionList projects={projects} /> : main)}
      {newSession}
      {error && <div className="toast error">{error}</div>}
    </div>
  );
}
