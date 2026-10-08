/**
 * Everything about the server that can be changed while it runs: where
 * players go, how long games are kept, and who may host. What the server needs
 * before it can read its own settings (its port, its database) is shown at the
 * bottom, read-only.
 */
import {
  PASSWORD_MIN_LENGTH, publicOrigin, SETTINGS_LIMITS,
  type AdminSessionView, type AppSettings, type AuditEntry, type Preset, type SettingsView,
} from '@buzzoff/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiFailure } from '../../lib/api';
import { plural } from '../../lib/format';
import { storage } from '../../lib/storage';
import { Button, cx, toast } from '../../ui/kit';
import { NumField, SelectField } from './fields';
import { HostShell, PageHead, useShell } from './HostShell';

export function Settings() {
  return (
    <HostShell>
      <SettingsPage />
    </HostShell>
  );
}

const range = (key: keyof typeof SETTINGS_LIMITS) => ({ min: SETTINGS_LIMITS[key].min, max: SETTINGS_LIMITS[key].max });
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** "Chrome on Windows" from a user-agent string: enough to tell your own devices apart. */
function device(agent: string): string {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : null;
  const system = /iPhone|iPad/.test(agent) ? 'iOS' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : null;
  if (!browser) return 'Unrecognised browser';
  return system ? `${browser} on ${system}` : browser;
}

const SETTING_LABEL: Record<keyof AppSettings, string> = {
  publicUrl: 'Players’ address',
  defaultPresetId: 'Default format',
  roomTtlHours: 'Idle games kept (hours)',
  finishedTtlHours: 'Finished games kept (hours)',
  maxUploadMb: 'Largest upload (MB)',
  sessionDays: 'Stay signed in (days)',
};

/** One line of plain English for an audit entry. */
function describe(entry: AuditEntry, presets: Preset[]): string {
  const { detail } = entry;
  switch (entry.action) {
    case 'login': return 'Signed in';
    case 'login.failed': return detail.during ? 'Wrong current password while changing the password' : 'Sign-in refused: wrong password';
    case 'logout': return 'Signed out';
    case 'password.set': return 'Host password set';
    case 'password.changed': return 'Host password changed; every device signed out';
    case 'password.imported': return 'Host password taken from BUZZOFF_ADMIN_PASSWORD';
    case 'password.reset': return 'Host password removed with the reset command';
    case 'sessions.revoked': return `Signed out ${plural(Number(detail.count ?? 0), 'other device')}`;
    case 'settings.imported': return `Settings carried over from the environment: ${((detail.from as string[] | undefined) ?? []).join(', ')}`;
    case 'settings.changed': {
      const changes = (detail.changes ?? {}) as Record<string, { from: unknown; to: unknown }>;
      const show = (key: string, value: unknown) =>
        value === null ? 'not set' : key === 'defaultPresetId' ? (presets.find((p) => p.id === value)?.name ?? String(value)) : String(value);
      return Object.entries(changes)
        .map(([key, { from, to }]) => `${SETTING_LABEL[key as keyof AppSettings] ?? key}: ${show(key, from)} → ${show(key, to)}`)
        .join(' · ');
    }
  }
}

function SettingsPage() {
  const { fail, refresh } = useShell();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [address, setAddress] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Take in what the server says is true now. `keepDraft` is for changes that did not touch the settings themselves. */
  const adopt = useCallback((next: SettingsView, keepDraft = false) => {
    setView(next);
    if (keepDraft) return;
    setDraft(next.settings);
    setAddress(next.settings.publicUrl ?? '');
  }, []);
  const loadLog = useCallback(() => api.audit().then(setLog, () => undefined), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.settings(), api.presets()]).then(
      ([settings, presetList]) => {
        if (cancelled) return;
        adopt(settings);
        setPresets(presetList);
      },
      (err) => !cancelled && setLoadError(fail(err)),
    );
    void loadLog();
    return () => {
      cancelled = true;
    };
  }, [adopt, fail, loadLog]);

  const typedAddress = address.trim();
  const origin = typedAddress ? publicOrigin(typedAddress) : null;
  const addressOk = !typedAddress || origin !== null;
  const pending = draft && { ...draft, publicUrl: origin };
  const dirty = !!view && !!pending && (!addressOk || JSON.stringify(pending) !== JSON.stringify(view.settings));

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  if (loadError) {
    return (
      <div className="mg-empty" role="alert">
        <h1>Couldn’t load the settings</h1>
        <p>{loadError}</p>
      </div>
    );
  }
  if (!view || !draft || !pending) {
    return (
      <div className="mg-empty">
        <i className="bz-spinner" aria-hidden />
      </div>
    );
  }

  const set = (patch: Partial<AppSettings>) => setDraft({ ...draft, ...patch });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving || !dirty) return;
    if (!addressOk) return setError('The players’ address needs to be a full address, like https://buzz.example.com');
    setSaving(true);
    setError(null);
    try {
      adopt(await api.saveSettings(pending!));
      toast('Settings saved', 'good');
      void loadLog();
      void refresh();
    } catch (err) {
      setError(fail(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mg-settings">
      <PageHead eyebrow="Server" title="Settings" lead="Changes apply the moment you save them. Nothing here needs a restart or a file edit." />

      {!view.server.persistent && (
        <p className="mg-note" role="note">
          <strong>This server has no database.</strong> Settings, like games and packs, last only until it restarts.
        </p>
      )}

      <form className="mg-stack mg-stack--l" onSubmit={save} noValidate>
        <div className="mg-savebar">
          <span className={cx('bz-pill', dirty ? 'bz-pill--buzz' : 'bz-pill--good')} aria-live="polite">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </span>
          {dirty && (
            <button type="button" className="mg-link" onClick={() => adopt(view)}>
              Discard
            </button>
          )}
          <Button type="submit" variant="primary" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
          {error && (
            <p className="mg-error mg-savebar__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <Group icon="📍" title="Joining" lead="Where the TV tells people to go. It is also what the QR code in the lobby opens.">
          <label className="bz-field">
            <span>Players’ address</span>
            <input
              className="bz-input"
              type="url"
              inputMode="url"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="https://buzz.example.com"
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!addressOk || undefined}
              aria-describedby="address-help"
            />
            <small id="address-help" data-bad={!addressOk || undefined}>
              {!addressOk
                ? 'Enter the address only, starting with http:// or https:// — no path after it.'
                : origin
                  ? `The lobby will say “${origin.replace(/^https?:\/\//, '')}”.`
                  : 'Empty: the lobby shows whatever address the TV itself was opened with. Fine at home; set it if players reach the server by another name.'}
            </small>
          </label>
        </Group>

        <Group icon="🎬" title="Games" lead="What a new game starts from, and how long the server holds on to games nobody is touching.">
          <div className="mg-fields">
            <div className="mg-fields__wide">
              <SelectField
                label="Default format"
                value={draft.defaultPresetId ?? ''}
                onChange={(id) => set({ defaultPresetId: id || null })}
                options={[['', 'Whichever was played last on that device'], ...presets.map((p) => [p.id, p.builtin ? p.name : `${p.name} (yours)`] as const)]}
                help="The format the New game page opens on. Hosts can still pick another."
              />
            </div>
            <NumField
              label="Keep idle games (hours)"
              value={draft.roomTtlHours}
              {...range('roomTtlHours')}
              onChange={(roomTtlHours) => set({ roomTtlHours })}
              help="A game nobody has touched for this long is deleted."
            />
            <NumField
              label="Keep finished games (hours)"
              value={draft.finishedTtlHours}
              {...range('finishedTtlHours')}
              onChange={(finishedTtlHours) => set({ finishedTtlHours })}
              help="How long a finished game stays open for a rematch. Results stay in History regardless."
            />
          </div>
        </Group>

        <Group icon="🖼️" title="Uploads" lead="Pictures, sound and video attached to questions.">
          <div className="mg-fields">
            <NumField
              label="Largest file (MB)"
              value={draft.maxUploadMb}
              {...range('maxUploadMb')}
              onChange={(maxUploadMb) => set({ maxUploadMb })}
              help="A reverse proxy in front of the server may have a lower limit of its own."
            />
          </div>
        </Group>

        <Group icon="⏳" title="Staying signed in" lead="How long a device that has entered the host password is trusted.">
          <div className="mg-fields">
            <NumField
              label="Sign-in lasts (days)"
              value={draft.sessionDays}
              {...range('sessionDays')}
              onChange={(sessionDays) => set({ sessionDays })}
              help="Applies from the next sign-in. Devices already signed in keep the time they were given."
            />
          </div>
        </Group>
      </form>

      <Group
        icon="🔑"
        title="Host password"
        lead="Needed to host games, edit question packs and open this page. Players never need it."
        tone={view.passwordSet ? undefined : 'warn'}
      >
        <PasswordForm
          passwordSet={view.passwordSet}
          onChanged={async () => {
            adopt(await api.settings(), true);
            void loadLog();
            void refresh();
          }}
        />
      </Group>

      {view.passwordSet && (
        <Group icon="💻" title="Signed-in devices" lead="Every browser currently trusted as host. Changing the password signs all of them out.">
          <Devices
            sessions={view.sessions}
            onSignedOutOthers={async () => {
              adopt(await api.settings(), true);
              void loadLog();
            }}
            onSignedOut={refresh}
          />
        </Group>
      )}

      <Group icon="📜" title="Activity" lead="Sign-ins, password changes and settings changes, newest first. Passwords themselves are never recorded.">
        {log.length === 0 ? (
          <p className="mg-muted">Nothing yet.</p>
        ) : (
          <div className="mg-table-wrap" tabIndex={0} role="group" aria-label="Activity log">
            <table className="mg-table mg-log">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">What happened</th>
                  <th scope="col">From</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id} data-bad={entry.action === 'login.failed' || undefined}>
                    <td>{when(entry.at)}</td>
                    <td>{describe(entry, presets)}</td>
                    <td className="bz-mono">{entry.ip === 'server' ? 'the server' : entry.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Group>

      <Group
        icon="🧱"
        title="Set where the server runs"
        lead="These stay in the server’s environment because it needs them before it can read anything else, or because they describe the network around it. Changing them means editing .env and restarting."
      >
        <dl className="mg-facts">
          <div>
            <dt>Version</dt>
            <dd className="bz-mono">{view.server.version}</dd>
          </div>
          <div>
            <dt>Database</dt>
            <dd>{view.server.persistent ? 'Connected' : 'None (in memory only)'}</dd>
          </div>
          <div>
            <dt>Trusted reverse proxies</dt>
            <dd>
              <span className="bz-mono">{view.server.trustProxy}</span> <small>TRUST_PROXY</small>
            </dd>
          </div>
          <div>
            <dt>Also set there</dt>
            <dd>
              <small>Port, database connection, media folder, log level</small>
            </dd>
          </div>
        </dl>
      </Group>
    </div>
  );
}

/** A settings section: what it is on the left, its controls on the right. */
function Group({ icon, title, lead, tone, children }: { icon: string; title: string; lead: string; tone?: 'warn'; children: ReactNode }) {
  return (
    <section className="bz-card mg-set" data-tone={tone}>
      <header className="mg-set__about">
        <span className="mg-set__icon" aria-hidden>
          {icon}
        </span>
        <h2>{title}</h2>
        <p>{lead}</p>
      </header>
      <div className="mg-set__body">{children}</div>
    </section>
  );
}

function PasswordForm({ passwordSet, onChanged }: { passwordSet: boolean; onChanged: () => Promise<void> }) {
  const { fail } = useShell();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const mismatch = again.length > 0 && again !== next;
  const ready = next.length >= PASSWORD_MIN_LENGTH && again === next && (!passwordSet || current.length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.changePassword(passwordSet ? current : undefined, next);
      storage.setAdminToken(token);
      setCurrent('');
      setNext('');
      setAgain('');
      toast(passwordSet ? 'Password changed. Other devices have been signed out.' : 'Password set. Hosting is now locked to it.', 'good');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiFailure && err.code === 'rate_limited' ? 'Too many attempts — wait a minute and try again.' : fail(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mg-stack" onSubmit={submit}>
      {!passwordSet && (
        <p className="mg-note" role="note">
          <strong>No host password is set.</strong> Anyone who can reach this server can host games, read every answer and change these settings.
        </p>
      )}
      {/* Lets a password manager file the password under a recognisable name. */}
      <input className="sr-only" type="text" name="username" autoComplete="username" value="BuzzOff host" readOnly tabIndex={-1} aria-hidden />
      <div className="mg-fields">
        {passwordSet && (
          <label className="bz-field mg-fields__wide">
            <span>Current password</span>
            <input className="bz-input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={200} />
          </label>
        )}
        <label className="bz-field">
          <span>{passwordSet ? 'New password' : 'Password'}</span>
          <input className="bz-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" maxLength={200} aria-invalid={tooShort || undefined} />
          <small data-bad={tooShort || undefined}>At least {PASSWORD_MIN_LENGTH} characters. A short sentence is easier to remember than a jumble.</small>
        </label>
        <label className="bz-field">
          <span>Type it again</span>
          <input className="bz-input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" maxLength={200} aria-invalid={mismatch || undefined} />
          <small data-bad={mismatch || undefined}>{mismatch ? 'The two do not match yet.' : 'Just to catch a slip of the finger.'}</small>
        </label>
      </div>
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={!ready || busy}>
        {busy ? 'Saving…' : passwordSet ? 'Change password' : 'Set password'}
      </Button>
      {passwordSet && (
        <p className="mg-muted">
          Forgotten it? On the server, run <code>docker compose exec buzzoff node apps/server/dist/index.js reset-admin-password</code>.
        </p>
      )}
    </form>
  );
}

function Devices({ sessions, onSignedOutOthers, onSignedOut }: { sessions: AdminSessionView[]; onSignedOutOthers: () => Promise<void>; onSignedOut: () => Promise<void> }) {
  const { fail } = useShell();
  const [busy, setBusy] = useState(false);
  const others = sessions.filter((s) => !s.current).length;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast(fail(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const signOutOthers = () =>
    run(async () => {
      const { ended } = await api.signOutOthers();
      toast(`Signed out ${plural(ended, 'other device')}`, 'good');
      await onSignedOutOthers();
    });
  const signOut = () =>
    run(async () => {
      await api.logout();
      storage.setAdminToken(null);
      await onSignedOut();
    });

  return (
    <div className="mg-stack">
      <ul className="mg-devices">
        {sessions.map((s) => (
          <li key={s.id} data-current={s.current || undefined}>
            <span>
              <strong>{device(s.agent)}</strong>
              {s.current && <span className="bz-pill bz-pill--good">This device</span>}
            </span>
            <small>
              <span className="bz-mono">{s.ip}</span> · signed in {when(s.createdAt)} · until {day(s.expiresAt)}
            </small>
          </li>
        ))}
      </ul>
      <div className="mg-row">
        <Button variant="ghost" size="s" disabled={busy || others === 0} onClick={() => void signOutOthers()}>
          Sign out other devices
        </Button>
        <Button variant="ghost" size="s" disabled={busy} onClick={() => void signOut()}>
          Sign out here
        </Button>
      </div>
    </div>
  );
}
