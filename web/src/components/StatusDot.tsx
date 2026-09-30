import type { SessionState } from '../../../shared/types';
import { STATE_LABEL } from '../status';

/** Status is shown by shape as well as color: filled = needs you, ring = working, hollow = idle. */
export function StatusDot({ state }: { state: SessionState }) {
  return <span className={`dot dot-${state}`} role="img" aria-label={STATE_LABEL[state]} />;
}

export function StatusPill({ state }: { state: SessionState }) {
  return (
    <span className={`pill pill-${state}`}>
      <StatusDot state={state} />
      {STATE_LABEL[state]}
    </span>
  );
}
