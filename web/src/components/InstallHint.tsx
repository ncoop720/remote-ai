import { useState } from 'react';
import { Close } from './icons';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** Right after pairing in a browser: how to keep remote-ai on the Home Screen, like an app. */
export function InstallHint() {
  const [open, setOpen] = useState(() => !standalone());
  if (!open) return null;
  const how = isIos() ? 'Tap Share, then Add to Home Screen' : 'Choose Add to Home screen (or Install app) in the browser menu';
  const push = window.isSecureContext ? ' Open it from there and turn on notifications with the bell.' : '';
  return (
    <div className="notice install-hint" role="status">
      <span className="grow">
        <strong>This device is connected.</strong> {how} to open remote-ai like an app.{push}
      </span>
      <button type="button" className="icon-btn icon-btn-small" aria-label="Dismiss" onClick={() => setOpen(false)}>
        <Close size={16} />
      </button>
    </div>
  );
}
