import { useMediaQuery, useProjects, useRoute } from './hooks';
import { NewSession } from './components/NewSession';
import { MobileSessionList, Sidebar } from './components/SessionLists';
import { SessionView } from './components/SessionView';

export function App() {
  const { projects, error, refresh } = useProjects();
  const route = useRoute();
  const isDesktop = useMediaQuery('(min-width: 900px)');

  if (!projects) {
    return <div className="splash">{error ? `Can't reach the server: ${error}` : 'Loading…'}</div>;
  }

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
        <main className="main">{main ?? <div className="empty-main">Pick a session, or start a new one.</div>}</main>
        {newSession}
        {error && <div className="toast error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="layout-mobile">
      {route.name === 'home' || route.name === 'new' ? <MobileSessionList projects={projects} /> : main}
      {newSession}
      {error && <div className="toast error">{error}</div>}
    </div>
  );
}
