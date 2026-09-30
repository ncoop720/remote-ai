import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { navigate, routes } from '../hooks';
import type { PermissionMode, ProjectInfo } from '../../../shared/types';
import { Close } from './icons';

const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'manual', label: 'Ask' },
  { id: 'acceptEdits', label: 'Edits' },
  { id: 'plan', label: 'Plan' },
];

/** Creates a worktree for a branch (or reuses one) and starts Claude in a tmux session there. */
export function NewSession({ projects, initialProject, onCreated }: {
  projects: ProjectInfo[];
  initialProject?: string;
  onCreated: () => void;
}) {
  const [project, setProject] = useState(initialProject ?? projects[0]?.name ?? '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<PermissionMode>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [cloning, setCloning] = useState(projects.length === 0);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);

  const defaultBranch = projects.find((p) => p.name === project)?.defaultBranch ?? 'main';

  const clone = async () => {
    setCloneBusy(true);
    setError(null);
    try {
      const { name } = await api.cloneProject(cloneUrl.trim());
      onCreated();
      setProject(name);
      setCloning(false);
      setCloneUrl('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCloneBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { id } = await api.createSession(project, {
        branch: branch.trim(),
        base: base.trim() || undefined,
        prompt: prompt.trim() || undefined,
        permissionMode: mode,
      });
      onCreated();
      navigate(routes.session(id));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop">
      <form className="sheet" onSubmit={(e) => void submit(e)}>
        <header className="sheet-head">
          <a className="icon-btn" href={routes.home()} aria-label="Close">
            <Close size={20} />
          </a>
          <h1>New session</h1>
        </header>

        <div className="field">
          <span>Project</span>
          <div className="chips" role="group" aria-label="Project">
            {projects.map((p) => (
              <button key={p.name} type="button" className="chip" aria-pressed={project === p.name} onClick={() => setProject(p.name)}>
                {p.name}
              </button>
            ))}
            <button type="button" className="chip chip-dashed" aria-expanded={cloning} onClick={() => setCloning((v) => !v)}>
              + Clone a repo
            </button>
          </div>
        </div>

        {cloning && (
          <div className="clone-box">
            <label className="field">
              <span>Repository URL</span>
              <input
                className="mono"
                value={cloneUrl}
                onChange={(e) => setCloneUrl(e.target.value)}
                placeholder="https://github.com/you/app.git"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
              />
            </label>
            <button type="button" className="btn" disabled={cloneBusy || !cloneUrl.trim()} onClick={() => void clone()}>
              {cloneBusy ? 'Cloning…' : 'Clone into ~/projects'}
            </button>
          </div>
        )}

        <div className="row">
          <label className="field grow">
            <span>New branch</span>
            <input
              className="mono"
              value={branch}
              onChange={(e) => setBranch(e.target.value.replace(/\s+/g, '-'))}
              placeholder="feat/dark-mode"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              required
            />
          </label>
          <label className="field field-narrow">
            <span>From</span>
            <input className="mono" value={base} onChange={(e) => setBase(e.target.value)} placeholder={defaultBranch} autoCapitalize="off" spellCheck={false} />
          </label>
        </div>

        <label className="field">
          <span>
            First prompt <span className="muted">(optional)</span>
          </span>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Add a dark-mode toggle to the header" />
        </label>

        <div className="field">
          <span>Permissions</span>
          <div className="segmented" role="group" aria-label="Permission mode">
            {MODES.map((m) => (
              <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary btn-large" disabled={busy || !project || !branch.trim()}>
          {busy ? 'Creating…' : 'Create session'}
        </button>
      </form>
    </div>
  );
}
