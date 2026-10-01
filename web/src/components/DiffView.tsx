import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import type { DiffFile, DiffResult, SessionInfo } from '../../../shared/types';
import { Close } from './icons';

const STATUS_LETTER: Record<DiffFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
};

/** The patch body without git's header lines (diff --git, index, ---, +++). */
function patchLines(patch: string): string[] {
  const lines = patch.replace(/\n$/, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@') || l.startsWith('Binary'));
  return start === -1 ? [] : lines.slice(start);
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'dl-hunk';
  if (line.startsWith('+')) return 'dl-add';
  if (line.startsWith('-')) return 'dl-del';
  if (line.startsWith('\\')) return 'dl-note';
  return '';
}

function FileDiff({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  return (
    <section className="diff-file">
      <button type="button" className="diff-file-head" aria-expanded={open} onClick={onToggle}>
        <span className={`diff-status diff-${file.status}`} title={file.status}>
          {STATUS_LETTER[file.status]}
        </span>
        <span className="diff-path mono">
          {file.oldPath ? (
            <>
              <span className="muted">{file.oldPath} → </span>
              {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <span className="diff-counts mono">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
      </button>
      {open && (
        <pre className="diff-body">
          {file.binary ? (
            <span className="dl-note">Binary file</span>
          ) : (
            patchLines(file.patch).map((line, i) => (
              <div key={i} className={`dl ${lineClass(line)}`}>
                {line || ' '}
              </div>
            ))
          )}
          {file.truncated && <div className="dl dl-note">… diff truncated</div>}
        </pre>
      )}
    </section>
  );
}

/** Review what the session changed since its branch point: commits, uncommitted edits and new files. */
export function DiffView({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api.diff(session.id);
      setDiff(d);
      // Small diffs open fully; large ones start collapsed so the file list stays readable.
      const lines = d.files.reduce((n, f) => n + f.additions + f.deletions, 0);
      setOpen(new Set(lines <= 400 ? d.files.map((f) => f.path) : []));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (p: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });

  return (
    <div className="sheet-backdrop diff-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="diff-sheet"
        role="dialog"
        aria-label="Changes"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="diff-head">
          <div className="grow">
            <h2>Changes</h2>
            {diff && (
              <div className="muted diff-sub">
                {diff.base ? `since ${diff.base} (${diff.against})` : 'uncommitted, against HEAD'} · {diff.files.length}{' '}
                {diff.files.length === 1 ? 'file' : 'files'} · <span className="add">+{diff.additions}</span>{' '}
                <span className="del">−{diff.deletions}</span>
              </div>
            )}
          </div>
          <button type="button" className="btn btn-small" disabled={loading} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button type="button" className="icon-btn" aria-label="Close" autoFocus onClick={onClose}>
            <Close size={20} />
          </button>
        </header>
        <div className="diff-files">
          {error && <p className="error">{error}</p>}
          {diff && diff.files.length === 0 && <p className="muted diff-empty">No changes yet.</p>}
          {diff?.files.map((f) => (
            <FileDiff key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
          ))}
          {diff?.truncated && <p className="muted diff-empty">Some files are left out: the diff is too large to show here.</p>}
        </div>
      </div>
    </div>
  );
}
