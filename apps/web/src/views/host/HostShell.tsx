/**
 * Chrome shared by every host management page: the header, and the password
 * gate when the server has one configured. Pages render inside it only once
 * the host is known to be allowed in.
 */
import type { ServerInfo } from '@buzzoff/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { api, ApiFailure } from '../../lib/api';
import { storage } from '../../lib/storage';
import { Button, cx, Logo } from '../../ui/kit';
import '../../styles/manage.css';

interface Shell {
  info: ServerInfo;
  /** Turn a caught error into a message; a 401 also sends the host back to the password form. */
  fail: (err: unknown) => string;
  /** Ask the server again who we are and what it is set to, after signing out or changing settings. */
  refresh: () => Promise<void>;
}

const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell must be used inside HostShell');
  return shell;
}

type Gate =
  | { state: 'loading' }
  | { state: 'offline'; message: string }
  | { state: 'login'; info: ServerInfo }
  | { state: 'ready'; info: ServerInfo };

const NAV = [
  { href: '/host', label: 'Games', match: (path: string) => path === '/host' || path.startsWith('/host/new') },
  { href: '/host/packs', label: 'Packs', match: (path: string) => path.startsWith('/host/packs') },
  { href: '/host/history', label: 'History', match: (path: string) => path.startsWith('/host/history') },
  { href: '/host/leaderboard', label: 'Leaderboard', match: (path: string) => path.startsWith('/host/leaderboard') },
  { href: '/host/settings', label: 'Settings', match: (path: string) => path.startsWith('/host/settings') },
];

/** Once the server has let this browser in, moving between host pages does not ask again. */
let admitted: ServerInfo | null = null;

export function HostShell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const [gate, setGate] = useState<Gate>(admitted ? { state: 'ready', info: admitted } : { state: 'loading' });
  const [path] = useLocation();

  const check = useCallback(async (quiet = false) => {
    if (admitted && !quiet) return;
    if (!quiet) setGate({ state: 'loading' });
    const admit = (info: ServerInfo) => setGate({ state: 'ready', info: (admitted = info) });
    try {
      const info = await api.info();
      if (!info.authRequired) return admit(info);
      try {
        await api.checkAuth();
        admit(info);
      } catch (err) {
        if (!(err instanceof ApiFailure) || err.status !== 401) throw err;
        admitted = null;
        setGate({ state: 'login', info });
      }
    } catch (err) {
      setGate({ state: 'offline', message: err instanceof ApiFailure ? err.message : 'Could not reach the server' });
    }
  }, []);

  useEffect(() => void check(), [check]);

  const info = gate.state === 'ready' || gate.state === 'login' ? gate.info : null;
  const shell = useMemo<Shell | null>(
    () =>
      info && {
        info,
        fail(err) {
          if (err instanceof ApiFailure && err.status === 401) {
            storage.setAdminToken(null);
            admitted = null;
            setGate({ state: 'login', info });
            return 'Your session has ended — sign in again';
          }
          return err instanceof Error ? err.message : 'Something went wrong';
        },
        refresh: () => check(true),
      },
    [info, check],
  );

  return (
    <div className="bz-stage mg">
      <header className="mg-top">
        <Logo size={24} to="/host" />
        <nav className="mg-nav" aria-label="Host pages">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={cx(item.match(path) && 'is-active')} aria-current={item.match(path) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <Link href="/host/new" className="bz-btn bz-btn--primary bz-btn--s mg-top__new">
          New game
        </Link>
      </header>

      <main className={cx('mg-page', wide && 'mg-page--wide')}>
        {gate.state === 'loading' && (
          <div className="mg-empty">
            <i className="bz-spinner" aria-hidden />
            <p>Warming up the studio…</p>
          </div>
        )}
        {gate.state === 'offline' && (
          <div className="mg-empty bz-rise" role="alert">
            <h1>Can’t reach the server</h1>
            <p>{gate.message}</p>
            <Button variant="primary" onClick={() => void check()}>
              Try again
            </Button>
          </div>
        )}
        {gate.state === 'login' && <Login onDone={() => setGate({ state: 'ready', info: (admitted = gate.info) })} />}
        {gate.state === 'ready' && shell && <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.login(password);
      storage.setAdminToken(token);
      onDone();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  return (
    <form className="bz-card mg-login bz-pop" onSubmit={submit}>
      <span className="mg-login__lock" aria-hidden>
        🔑
      </span>
      <h1>Host sign-in</h1>
      <p>Hosting is password-protected on this server. Players never need this.</p>
      <label className="bz-field">
        <span>Host password</span>
        <input className="bz-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
      </label>
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" size="l" block disabled={!password || busy}>
        {busy ? 'Checking…' : 'Sign in'}
      </Button>
    </form>
  );
}

/** A page title with an optional lead and actions on the right. */
export function PageHead({ eyebrow, title, lead, children }: { eyebrow?: string; title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mg-head">
      <div>
        {eyebrow && <p className="bz-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {lead && <p className="mg-head__lead">{lead}</p>}
      </div>
      {children && <div className="mg-head__actions">{children}</div>}
    </div>
  );
}
