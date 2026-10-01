import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from './api';
import type { AuthInfo } from '../../shared/types';
import { useMediaQuery, useProjects, useRoute } from './hooks';
import { Login } from './components/Login';
import { NewSession } from './components/NewSession';
import { MobileSessionList, Sidebar } from './components/SessionLists';
import { SessionView } from './components/SessionView';
import { setupNeeded, SetupView, useSetup } from './components/SetupView';
import { ConnectView } from './components/ConnectView';
import { InstallHint } from './components/InstallHint';

const SKIP_KEY = 'ra-setup-skipped';

function readSkipped(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A device's first visit can bring a code: a pairing code in the link from the computer's QR code
 * (#/pair/CODE), or the sign-in code an iPhone's Home Screen app gets from its manifest (?handoff=).
 * Use it, tidy the address, then see whether this browser may use the dashboard.
 */
async function arrive(): Promise<{ info: AuthInfo | null; paired: boolean; error: string | null }> {
  const params = new URLSearchParams(window.location.search);
  const handoff = params.get('handoff');
  if (handoff) {
    await api.handoff(handoff).catch(() => undefined);
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
  }
  let paired = false;
  let error: string | null = null;
  const pairing = /^#\/pair\/([A-Za-z0-9-]+)/.exec(window.location.hash);
  if (pairing) {
    window.history.replaceState(null, '', `${window.location.pathname}#/`);
    try {
      await api.pair(pairing[1]!);
      paired = true;
    } catch (err) {
      error = errorMessage(err);
    }
  }
  const info = await api.auth().catch(() => null);
  return { info, paired, error };
}

/** Shows the pairing screen when this browser isn't connected to the computer yet. */
export function App() {
  const [state, setState] = useState<{ info: AuthInfo | null; paired: boolean; error: string | null } | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  useEffect(() => {
    void arrive().then((s) => {
      setState(s);
      setNeedsLogin(Boolean(s.info?.required));
    });
    const onRequired = () => setNeedsLogin(true);
    window.addEventListener('ra-login-required', onRequired);
    return () => window.removeEventListener('ra-login-required', onRequired);
  }, []);

  if (!state) return <div className="splash">Loading…</div>;
  if (needsLogin) return <Login info={state.info} initialError={state.error} onDone={() => window.location.reload()} />;
  return <Dashboard justPaired={state.paired} local={state.info?.local ?? false} />;
}

function Dashboard({ justPaired, local }: { justPaired: boolean; local: boolean }) {
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
  const page = route.name === 'connect' ? <ConnectView local={local} /> : (route.name === 'setup' || autoSetup) && (
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
        <main className="main">{page || main || <div className="empty-main">Pick a session, or start a new one.</div>}</main>
        {newSession}
        {error && <div className="toast error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="layout-mobile">
      {justPaired && <InstallHint />}
      {page || (route.name === 'home' || route.name === 'new' ? <MobileSessionList projects={projects} /> : main)}
      {newSession}
      {error && <div className="toast error">{error}</div>}
    </div>
  );
}
