import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { desktopApp } from '../desktop';
import { routes } from '../hooks';
import type { AgentInfo, DeviceInfo, ProjectInfo, SetupInfo } from '../../../shared/types';
import { Check, ChevronLeft, Folder } from './icons';
import { Terminal } from './Terminal';

/** Whether the dashboard can't be used yet: no projects, or the default agent can't run. */
export function setupNeeded(setup: SetupInfo | null, projects: ProjectInfo[]): boolean {
  const agent = setup?.agents[0];
  return projects.length === 0 || Boolean(setup && (!setup.git.installed || !agent?.installed || !agent.signedIn));
}

const GIT_HELP: Record<string, React.ReactNode> = {
  darwin: (
    <>
      Run <code>xcode-select --install</code> in Terminal, or get it from <a href="https://git-scm.com/download/mac">git-scm.com</a>.
    </>
  ),
  win32: (
    <>
      Install <a href="https://git-scm.com/download/win">Git for Windows</a>. Claude Code needs it too.
    </>
  ),
  linux: (
    <>
      Install it with your package manager, for example <code>sudo apt install git</code>.
    </>
  ),
};

function Step({ done, title, children }: { done: boolean; title: string; children: React.ReactNode }) {
  return (
    <li className={`setup-step${done ? ' setup-step-done' : ''}`}>
      <span className="setup-mark" aria-label={done ? 'Done' : 'To do'}>
        {done && <Check size={14} />}
      </span>
      <div className="setup-step-body">
        <h2>{title}</h2>
        {children}
      </div>
    </li>
  );
}

/** Install and sign in to an agent, each in a terminal on the page. */
function AgentStep({ agent, onChanged }: { agent: AgentInfo; onChanged: () => Promise<void> }) {
  const [task, setTask] = useState<{ session: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = agent.installed && agent.signedIn;

  // While a terminal is open, look for the result every few seconds.
  useEffect(() => {
    if (!task) return;
    const timer = setInterval(() => void onChanged(), 3000);
    return () => clearInterval(timer);
  }, [task, onChanged]);

  const start = async (kind: 'install' | 'signin') => {
    setError(null);
    try {
      setTask(await api.agentTask(agent.id, kind));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  let text: React.ReactNode;
  if (ready) text = `${agent.name} ${agent.version ?? ''} is installed and signed in.`;
  else if (agent.installed) text = `${agent.name} ${agent.version ?? ''} is installed. Sign in with your Claude plan or an API key.`;
  else text = `remote-ai runs ${agent.name} with your own plan. Install it with Anthropic's official installer.`;

  return (
    <Step done={ready} title={agent.name}>
      <p>{text}</p>
      {!ready && (
        <div className="row">
          {!agent.installed ? (
            <button type="button" className="btn btn-primary" onClick={() => void start('install')}>
              Install {agent.name}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => void start('signin')}>
              Sign in
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {task && (
        <div className="setup-terminal">
          <Terminal key={task.name} sessionId={task.session} name={task.name} fontSize={12} />
          <button type="button" className="link-btn" onClick={() => setTask(null)}>
            Close
          </button>
        </div>
      )}
    </Step>
  );
}

function ProjectsStep({ projects, onChanged }: { projects: ProjectInfo[]; onChanged: () => Promise<void> }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (path: string | null) => {
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      await api.addProject(path);
      setTyped('');
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    try {
      await api.removeProject(name);
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add(typed.trim());
  };

  return (
    <Step done={projects.length > 0} title="Projects">
      <p>Add the git repositories you work on. Each session gets its own worktree of one, so your checkout stays as it is.</p>
      {projects.length > 0 && (
        <ul className="setup-projects">
          {projects.map((p) => (
            <li key={p.name}>
              <Folder size={15} />
              <span className="grow">
                <span className="setup-project-name">{p.name}</span>
                <span className="mono muted ellipsis">{p.path}</span>
              </span>
              {p.source === 'added' && (
                <button type="button" className="link-btn" onClick={() => void remove(p.name)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="row setup-add" onSubmit={submit}>
        {desktopApp && (
          <button type="button" className="btn" disabled={busy} onClick={() => void desktopApp?.pickFolder().then(add)}>
            Choose a folder…
          </button>
        )}
        <input
          className="mono grow"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={desktopApp ? 'or type its path' : 'Path to a repository on the computer, e.g. ~/code/app'}
          aria-label="Repository path"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={busy || !typed.trim()}>
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </Step>
  );
}

/** Optional: phones are for later, so this never holds the checklist up. */
function PhoneStep() {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  useEffect(() => {
    api.devices().then(setDevices, () => setDevices([]));
  }, []);
  const n = devices?.length ?? 0;
  return (
    <Step done={n > 0} title="Connect your phone (optional)">
      <p>
        {n > 0
          ? `${n} device${n === 1 ? ' is' : 's are'} paired.`
          : 'Scan a QR code to use remote-ai from your phone, on this Wi-Fi or anywhere with Tailscale.'}
      </p>
      <div className="row">
        <a className="btn" href={routes.connect()}>
          {n > 0 ? 'Manage devices' : 'Connect a phone'}
        </a>
      </div>
    </Step>
  );
}

/** The first-run checklist: git, the coding agent, projects, and (optionally) a phone. */
export function SetupView({ projects, setup, refresh, onSkip }: {
  projects: ProjectInfo[];
  setup: SetupInfo | null;
  refresh: () => Promise<void>;
  /** Shown when the checklist opened by itself, so it can be put off. */
  onSkip?: () => void;
}) {
  if (!setup) return <div className="empty-main">Checking this computer…</div>;
  const done = !setupNeeded(setup, projects);

  return (
    <div className="setup">
      <header className="setup-head">
        {!onSkip && (
          <a className="icon-btn" href={routes.home()} aria-label="Back">
            <ChevronLeft size={22} />
          </a>
        )}
        <div>
          <h1>Set up remote-ai</h1>
          <p className="muted">A few things this computer needs before you start sessions.</p>
        </div>
      </header>
      <ol className="setup-steps">
        <Step done={setup.git.installed} title="Git">
          {setup.git.installed ? (
            <p>git {setup.git.version} is installed.</p>
          ) : (
            <p>remote-ai keeps each session in its own git worktree. {GIT_HELP[setup.platform] ?? GIT_HELP.linux}</p>
          )}
        </Step>
        {setup.agents.map((a) => (
          <AgentStep key={a.id} agent={a} onChanged={refresh} />
        ))}
        <ProjectsStep projects={projects} onChanged={refresh} />
        <PhoneStep />
      </ol>
      <div className="row setup-foot">
        {done ? (
          <a className="btn btn-primary" href={routes.newSession()}>
            Start a session
          </a>
        ) : (
          onSkip && (
            <button type="button" className="link-btn" onClick={onSkip}>
              Skip for now
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Setup info, refreshed on demand. */
export function useSetup() {
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSetup(await api.setup());
    } catch {
      // the projects list shows connection errors
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { setup, refresh };
}
