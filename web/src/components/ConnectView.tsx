import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { routes } from '../hooks';
import type { DeviceInfo, PairingCode, RemoteInfo, TailscaleInfo } from '../../../shared/types';
import { ChevronLeft } from './icons';

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

const VIA: Record<DeviceInfo['via'], string> = { wifi: 'Wi-Fi', tailscale: 'Tailscale', other: 'browser' };

function Switch({ on, disabled, label, onChange }: { on: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

/** The QR code and typed code for pairing; a new code replaces it once used or expired. */
function PairingCard({ code, onRenew }: { code: PairingCode; onRenew: () => void }) {
  const [via, setVia] = useState(code.links[0]?.via);
  const link = code.links.find((l) => l.via === via) ?? code.links[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const minutes = Math.max(0, Math.ceil((code.expiresAt - now) / 60_000));
  if (!link) return null;

  return (
    <section className="connect-card connect-pair">
      {/* The SVG comes from our own server (the qrcode package), not from the network. */}
      <div className="connect-qr" dangerouslySetInnerHTML={{ __html: link.qrSvg }} />
      <div className="connect-pair-body">
        <h2>Scan with your phone's camera</h2>
        <p>
          Or open <span className="mono">{link.url.replace(/\/#\/pair\/.*$/, '')}</span> and type{' '}
          <strong className="mono connect-code">{code.code}</strong>
        </p>
        <p className="muted">
          The code works once, for the next {minutes} min.{' '}
          <button type="button" className="link-btn" onClick={onRenew}>
            New code
          </button>
        </p>
        {code.links.length > 1 && (
          <div className="segmented segmented-small" role="group" aria-label="Address">
            {code.links.map((l) => (
              <button key={l.via} type="button" aria-pressed={l.via === link.via} onClick={() => setVia(l.via)}>
                {l.via === 'tailscale' ? 'Tailscale' : 'This Wi-Fi'}
              </button>
            ))}
          </div>
        )}
        <p className="muted">
          Then add it to the Home Screen (on iPhone: Share, then Add to Home Screen) and open it from there.
          {link.via === 'tailscale' ? ' Turn on notifications with the bell.' : ' Notifications need the Tailscale address.'}
        </p>
      </div>
    </section>
  );
}

function TailscaleCard({ ts, local, onToggle }: { ts: TailscaleInfo; local: boolean; onToggle: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  let body: React.ReactNode;
  if (!ts.available) body = <p className="muted">Built-in Tailscale comes with the desktop app.</p>;
  else if (!ts.enabled) {
    body = (
      <p>
        Reach this computer from anywhere, over HTTPS, so notifications and the installed app work too. Your phone needs the
        Tailscale app, signed in to the same tailnet.
      </p>
    );
  } else if (ts.state === 'starting' || ts.state === 'off') body = <p className="muted">Starting…</p>;
  else if (ts.state === 'needs-login') {
    body = (
      <>
        <p>Sign this computer in to Tailscale. It joins your tailnet as its own device, so the Tailscale app isn't needed here.</p>
        {ts.loginUrl && (
          <a className="btn btn-primary" href={ts.loginUrl} target="_blank" rel="noreferrer">
            Sign in to Tailscale
          </a>
        )}
      </>
    );
  } else if (ts.state === 'needs-approval') body = <p>{ts.message ?? 'Waiting for an admin of the tailnet to approve this device.'}</p>;
  else if (ts.state === 'running') {
    body = (
      <>
        <p>
          On your tailnet at <span className="mono">{ts.url}</span>
          {ts.login && (
            <>
              , signed in as <strong>{ts.login}</strong>. Your own devices signed in to Tailscale as {ts.login} open it without a
              code; other people's need one.
            </>
          )}
        </p>
        {ts.https === false && (
          <p className="connect-warn">
            HTTPS is off for this tailnet, so there are no notifications.{' '}
            <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">
              Turn on MagicDNS and HTTPS Certificates
            </a>
            , then turn Tailscale off and on here.
          </p>
        )}
        {local && (
          <button type="button" className="link-btn" onClick={() => void api.tailscaleLogout()}>
            Sign this computer out of Tailscale
          </button>
        )}
      </>
    );
  } else body = <p className="error">{ts.message ?? 'Tailscale stopped.'}</p>;

  return (
    <section className="connect-card">
      <header className="connect-card-head">
        <h2>Anywhere, with Tailscale</h2>
        {ts.available && (
          <Switch
            on={ts.enabled}
            label="Tailscale"
            disabled={!local || busy}
            onChange={(on) => {
              setBusy(true);
              void Promise.resolve(onToggle(on)).finally(() => setBusy(false));
            }}
          />
        )}
      </header>
      {body}
    </section>
  );
}

/** Pair phones and other browsers, and choose how they reach this computer. */
export function ConnectView({ local }: { local: boolean }) {
  const [remote, setRemote] = useState<RemoteInfo | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [code, setCode] = useState<{ key: string; value: PairingCode } | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, d] = await Promise.all([api.remote(), api.devices()]);
      setRemote(r);
      setDevices(d);
      // A device that wasn't here before just used the code: say so, and show a fresh one.
      const fresh = known.current ? d.find((x) => !known.current!.has(x.id)) : undefined;
      known.current = new Set(d.map((x) => x.id));
      if (fresh) {
        setJustPaired(fresh.name);
        setCode(null);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const reachable = Boolean(remote && (remote.wifi.enabled || (remote.tailscale.state === 'running' && remote.tailscale.url)));
  // The addresses a code's links were made for; a code is replaced when they change.
  const linkKey = remote ? `${remote.wifi.urls[0] ?? ''}|${remote.tailscale.state === 'running' ? remote.tailscale.url : ''}` : '';
  const pending = useRef(false);
  useEffect(() => {
    if (!reachable) {
      setCode(null);
      return;
    }
    if ((code && code.key === linkKey) || pending.current) return;
    pending.current = true;
    api
      .newPairingCode()
      .then((value) => setCode({ key: linkKey, value }), (err: unknown) => setError(errorMessage(err)))
      .finally(() => (pending.current = false));
  }, [reachable, linkKey, code]);
  // Expired: drop it, and the effect above makes another.
  useEffect(() => {
    if (!code) return;
    const t = setTimeout(() => setCode(null), Math.max(1000, code.value.expiresAt - Date.now()));
    return () => clearTimeout(t);
  }, [code]);

  const set = async (body: { wifi?: boolean; tailscale?: boolean }) => {
    setError(null);
    try {
      setRemote(await api.setRemote(body));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await api.removeDevice(id);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (!remote) return <div className="empty-main">{error ?? 'Loading…'}</div>;
  const wifi = remote.wifi;

  return (
    <div className="setup connect">
      <header className="setup-head">
        <a className="icon-btn" href={routes.home()} aria-label="Back">
          <ChevronLeft size={22} />
        </a>
        <div>
          <h1>Connect a phone</h1>
          <p className="muted">Use remote-ai from your phone or another computer. Each device pairs once with a code from here.</p>
        </div>
      </header>

      {justPaired && <div className="connect-done">{justPaired} is connected.</div>}
      {code ? (
        <PairingCard key={code.value.code} code={code.value} onRenew={() => setCode(null)} />
      ) : (
        !reachable && <p className="connect-none">Turn on Tailscale or this Wi-Fi below to show a pairing code.</p>
      )}
      {!local && <p className="muted">Only the computer itself can turn these on or off.</p>}

      <TailscaleCard ts={remote.tailscale} local={local} onToggle={(on) => set({ tailscale: on })} />

      <section className="connect-card">
        <header className="connect-card-head">
          <h2>On this Wi-Fi</h2>
          <Switch on={wifi.enabled} label="This Wi-Fi" disabled={!local} onChange={(on) => void set({ wifi: on })} />
        </header>
        {wifi.enabled ? (
          <p>
            Phones on the same network can open{' '}
            {wifi.urls.length > 0 ? <span className="mono">{wifi.urls.join(', ')}</span> : 'this computer (no network address found)'}.
          </p>
        ) : (
          <p>Lets phones on the same network connect, over plain http.</p>
        )}
        <p className="muted">
          Use it on networks you trust: http can be read by others on the network, and phones can't get notifications over it.
        </p>
        {wifi.error && <p className="error">{wifi.error}</p>}
      </section>

      <section className="connect-card">
        <header className="connect-card-head">
          <h2>Paired devices</h2>
        </header>
        {devices.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="setup-projects">
            {devices.map((d) => (
              <li key={d.id}>
                <span className="grow">
                  <span className="setup-project-name">{d.name}</span>
                  <span className="muted">
                    paired over {VIA[d.via]} · last used {ago(d.lastSeenAt)}
                  </span>
                </span>
                <button type="button" className="link-btn" onClick={() => void remove(d.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
