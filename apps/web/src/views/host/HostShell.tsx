/**
 * Chrome shared by every host management page: the header, and the password
 * gate when the server has one configured. Pages render inside it only once
 * the host is known to be allowed in.
 */
import type { ServerInfo } from '@buzzoff/shared';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
  /** `keep`: the page was open with unsaved work when the session ended, so it stays where it is under the form. */
  | { state: 'login'; info: ServerInfo; keep?: boolean }
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
/** How many pages on screen are holding work that has not been saved. */
let unsavedPages = 0;

/**
 * Look after work that has not been saved: ask before the tab is closed or a link is followed, and
 * keep the page as it is if the session ends underneath it.
 */
export function useUnsavedWork(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      // A link opened in another tab or window leaves this page where it is.
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const link = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
      if (!window.confirm('Leave without saving? Your changes will be lost.')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    unsavedPages++;
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      unsavedPages--;
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
}

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
      // A refresh behind a page that is already open is not worth losing the page over.
      if (!quiet) setGate({ state: 'offline', message: err instanceof ApiFailure ? err.message : 'Couldn’t reach the server. Check your connection.' });
    }
  }, []);

  useEffect(() => void check(), [check]);

  // Anything that sticks below the header (a save bar) needs to know how tall it is. That depends on
  // the screen: one row or two, and how much the status bar takes when installed on a phone.
  const page = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const header = top.current;
    if (!header) return;
    const measure = () => page.current?.style.setProperty('--mg-top-height', `${header.offsetHeight}px`);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(header);
    return () => watcher.disconnect();
  }, []);

  // Both are the same function for as long as the page is open, so a page's effects can depend on them.
  const fail = useCallback((err: unknown) => {
    if (err instanceof ApiFailure && err.status === 401) {
      storage.setAdminToken(null);
      admitted = null;
      setGate((g) => (g.state === 'ready' ? { state: 'login', info: g.info, keep: unsavedPages > 0 } : g));
      return 'You’ve been signed out. Sign in again.';
    }
    return err instanceof Error ? err.message : 'Something went wrong';
  }, []);
  const refresh = useCallback(() => check(true), [check]);

  const info = gate.state === 'ready' || gate.state === 'login' ? gate.info : null;
  const shell = useMemo<Shell | null>(() => info && { info, fail, refresh }, [info, fail, refresh]);
  const showPage = gate.state === 'ready' || (gate.state === 'login' && gate.keep);

  return (
    <div ref={page} className="bz-stage mg">
      <header ref={top} className="mg-top">
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
        {gate.state === 'login' && <Login interrupted={gate.keep} onDone={() => setGate({ state: 'ready', info: (admitted = gate.info) })} />}
        {showPage && shell && <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>}
      </main>
    </div>
  );
}

function Login({ interrupted, onDone }: { interrupted?: boolean; onDone: () => void }) {
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
      <p>{interrupted ? 'You’ve been signed out. Sign in again and carry on: your unsaved changes are still here.' : 'Hosting needs a password on this server. Players never need it.'}</p>
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
