/**
 * Set up a game: pick a format, pick the questions, press Create. Everything
 * else on the page is optional and stays folded away until it is wanted.
 */
import {
  GameRulesSchema, normalizeRoomCode, ROOM_CODE_LENGTH,
  type CreateGameRequest, type GameInfo, type GameRules, type Pack, type PackSummary, type Picks, type Preset, type RoundDef,
} from '@buzzoff/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../../lib/api';
import { plural } from '../../lib/format';
import { storage } from '../../lib/storage';
import { Button, cx, Modal, toast } from '../../ui/kit';
import { HostShell, PageHead, useShell } from './HostShell';
import { MODE_ICON, RulesEditor } from './RulesEditor';

export function NewGame() {
  return (
    <HostShell wide>
      <Setup />
    </HostShell>
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Say what is wrong with the rules in the host's terms rather than as a path into them. */
function describeIssue(rules: GameRules, path: PropertyKey[], message: string): string {
  const empty = /^Too small/.test(message);
  if (path[0] === 'name' && empty) return 'Give the game a name.';
  if (path[0] === 'rounds' && typeof path[1] === 'number') {
    const round = `Round ${path[1] + 1}${rules.rounds[path[1]]?.title.trim() ? ` (${rules.rounds[path[1]].title.trim()})` : ''}`;
    return path[2] === 'title' && empty ? `Round ${path[1] + 1} needs a title.` : `Check ${round}: ${message}`;
  }
  if (path[0] === 'teams' && path[1] === 'names' && empty) return 'Every team needs a name.';
  return `Check the rules (${path.map(String).join(' › ')}): ${message}`;
}

/** How many categories (or, for Fast Money, survey questions) a round draws. A final round takes one category. */
const drawCount = (r: RoundDef) => (r.mode === 'trivia' ? r.categories : r.mode === 'final' ? 1 : r.questions);

/** What a ruleset draws from the selected packs. */
function needs(rules: GameRules) {
  const total = (rounds: RoundDef[]) => rounds.reduce((n, r) => n + drawCount(r), 0);
  return {
    categories: total(rules.rounds.filter((r) => r.mode !== 'fastMoney')),
    surveys: total(rules.rounds.filter((r) => r.mode === 'fastMoney')),
  };
}

function Setup() {
  const { fail, info } = useShell();
  const [, navigate] = useLocation();
  // The room the next game is played in, when it is one whose players are staying on; otherwise a new room is made.
  const [rematch, setRematch] = useState(() => {
    const code = normalizeRoomCode(new URLSearchParams(window.location.search).get('rematch') ?? '');
    return code.length === ROOM_CODE_LENGTH && storage.hostKey(code) ? code : null;
  });
  const arrivedFor = useRef(rematch).current;
  /** A room of this browser's whose game is over and whose players are still in it. */
  const [waiting, setWaiting] = useState<GameInfo | null>(null);

  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [presetId, setPresetId] = useState('');
  const [rules, setRules] = useState<GameRules | null>(null);
  const [packIds, setPackIds] = useState<string[]>([]);
  const [picks, setPicks] = useState<Picks>([]);
  const [full, setFull] = useState<Record<string, Pack>>({});
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.presets(), api.packs()]).then(
      ([presetList, packList]) => {
        if (cancelled) return;
        const last = storage.lastSetup();
        // What this browser kept may have been written by an older version: use it only if it still holds up.
        const kept = arrivedFor ? storage.gameSetup(arrivedFor) : null;
        const keptRules = GameRulesSchema.safeParse(kept?.rules);
        const previous = kept && keptRules.success ? { packIds: kept.packIds, rules: keptRules.data } : null;
        // The server's chosen default, else whatever this browser played last, else the flagship format.
        const wantedPreset = info.defaultPresetId ?? last?.presetId;
        const preset = presetList.find((p) => p.id === wantedPreset) ?? presetList.find((p) => p.id === 'full-show') ?? presetList[0];
        const wanted = (previous?.packIds ?? last?.packIds ?? []).filter((id) => packList.some((p) => p.id === id));
        setPresets(presetList);
        setPacks(packList);
        // A rematch starts from exactly what was just played.
        setRules(previous?.rules ?? preset.rules);
        setPresetId(previous ? (presetList.find((p) => same(p.rules, previous.rules))?.id ?? preset.id) : preset.id);
        setPackIds(wanted.length ? wanted : packList.slice(0, 1).map((p) => p.id));
        setPicks((previous?.rules ?? preset.rules).rounds.map(() => null));
      },
      (err) => !cancelled && setLoadError(fail(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [fail, arrivedFor, info.defaultPresetId]);

  // A host who comes here straight after a game is offered its room, so the players in it are not left behind.
  useEffect(() => {
    let cancelled = false;
    // Newest first, as the browser lists them.
    void Promise.all(storage.hostedGames().map((game) => api.game(game.code).catch(() => null))).then((rooms) => {
      if (!cancelled) setWaiting(rooms.find((room) => room?.phase === 'finished' && room.playerCount > 0) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hand-picking needs the packs' contents, which are only fetched once asked for.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    if (!picking) return;
    for (const id of packIds) {
      if (requested.current.has(id)) continue;
      requested.current.add(id);
      api.pack(id).then(
        (pack) => setFull((f) => ({ ...f, [id]: pack })),
        (err) => {
          requested.current.delete(id);
          setError(fail(err));
        },
      );
    }
  }, [picking, packIds, fail]);

  if (loadError) {
    return (
      <div className="mg-empty" role="alert">
        <h1>Couldn’t load the setup</h1>
        <p>{loadError}</p>
      </div>
    );
  }
  if (!presets || !packs || !rules) {
    return (
      <div className="mg-empty">
        <i className="bz-spinner" aria-hidden />
      </div>
    );
  }

  const preset = presets.find((p) => p.id === presetId);
  const customised = !!preset && !same(preset.rules, rules);
  const chosen = packs.filter((p) => packIds.includes(p.id));
  const need = needs(rules);
  const have = { categories: chosen.reduce((n, p) => n + p.categoryCount, 0), surveys: chosen.reduce((n, p) => n + p.surveyCount, 0) };
  const parsed = GameRulesSchema.safeParse(rules);
  const issue = parsed.success ? null : parsed.error.issues[0];

  let blocker: string | null = null;
  if (!packs.length) blocker = 'There are no question packs yet. Create or import one first.';
  else if (!chosen.length) blocker = 'Pick at least one question pack.';
  else if (issue) blocker = describeIssue(rules, issue.path, issue.message);
  else if (have.categories < need.categories) {
    blocker = `These rules need ${plural(need.categories, 'category', 'categories')} but the selected ${chosen.length === 1 ? 'pack has' : 'packs have'} ${have.categories}. Add a pack or shrink a board.`;
  } else if (have.surveys < need.surveys) {
    blocker = `These rules need ${plural(need.surveys, 'survey question')} but the selected ${chosen.length === 1 ? 'pack has' : 'packs have'} ${have.surveys}. Add a pack or use fewer questions.`;
  }

  function choosePreset(next: Preset) {
    setPresetId(next.id);
    setRules(next.rules);
    setPicks(next.rules.rounds.map(() => null));
  }

  function togglePack(id: string) {
    const removing = packIds.includes(id);
    setPackIds(removing ? packIds.filter((x) => x !== id) : [...packIds, id]);
    // Hand-picks may have come from the pack being taken away. Adding a pack leaves them as they are.
    if (removing) setPicks(rules!.rounds.map(() => null));
  }

  function changeRules(next: GameRules, structural?: boolean) {
    setRules(next);
    if (structural || next.rounds.length !== picks.length) setPicks(next.rounds.map(() => null));
    // A round that now draws fewer items keeps only as many hand-picks as it can use.
    else setPicks(picks.map((p, i) => p && p.slice(0, drawCount(next.rounds[i]))));
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (blocker || busy || !parsed.success) return;
    setBusy(true);
    setError(null);
    const handPicked = picks.some((p) => p?.length);
    const req: CreateGameRequest = {
      packIds,
      rules: parsed.data,
      ...(handPicked ? { picks: parsed.data.rounds.map((_, i) => (picks[i]?.length ? picks[i] : null)) } : {}),
    };
    try {
      storage.setLastSetup({ packIds, presetId });
      if (rematch) {
        await api.rematch(rematch, req);
        storage.setGameSetup(rematch, req);
        navigate(`/host/game/${rematch}`);
      } else {
        const { code, hostKey } = await api.createGame(req);
        storage.addHostedGame({ code, hostKey, name: req.rules.name, createdAt: Date.now() });
        storage.setGameSetup(code, req);
        navigate(`/host/game/${code}`);
      }
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  async function deletePreset(target: Preset) {
    if (!window.confirm(`Delete the format “${target.name}”?`)) return;
    try {
      await api.deletePreset(target.id);
      const next = presets!.filter((p) => p.id !== target.id);
      setPresets(next);
      if (presetId === target.id) choosePreset(next[0]);
    } catch (err) {
      toast(fail(err), 'error');
    }
  }

  return (
    // Enter in a field is not "create the game": only the button at the bottom is.
    <form className="mg-setup" onSubmit={create} onKeyDown={(e) => e.key === 'Enter' && e.target instanceof HTMLInputElement && e.preventDefault()}>
      <PageHead
        eyebrow={rematch ? `Room ${rematch}` : 'Host'}
        title={rematch ? 'Next game' : 'New game'}
        lead={rematch ? 'Same room, same players: nobody has to join again. Scores go back to zero.' : 'Pick a format and some questions. You can start in two clicks.'}
      >
        {rematch && (
          <Button variant="ghost" size="s" onClick={() => setRematch(null)}>
            Use a new room instead
          </Button>
        )}
      </PageHead>

      {waiting && !rematch && (
        <div className="mg-note mg-note--act" role="note">
          <p>
            <strong>
              {plural(waiting.playerCount, 'player')} {waiting.playerCount === 1 ? 'is' : 'are'} still in room {waiting.code}.
            </strong>{' '}
            Keep them for this game and nobody has to scan or join again. A new room gets a new code that everyone joins from scratch.
          </p>
          <Button variant="primary" size="s" onClick={() => setRematch(waiting.code)}>
            Keep these players
          </Button>
        </div>
      )}

      {/* The two choices that matter sit side by side where there is room; everything optional folds away below. */}
      <div className="mg-setup__pick">
        <section className="mg-section">
          <div className="mg-section__head">
            <h2>
              <span className="mg-step">1</span> Format
            </h2>
          </div>
          <div className="mg-grid" role="radiogroup" aria-label="Format">
            {presets.map((p) => (
              <label key={p.id} className="mg-choice">
                <input type="radio" name="preset" checked={p.id === presetId} onChange={() => choosePreset(p)} />
                <span className="mg-choice__body">
                  <span className="mg-choice__title">
                    {p.name}
                    {p.id === presetId && customised && <span className="bz-pill bz-pill--cyan">customised</span>}
                    {!p.builtin && <span className="bz-pill">yours</span>}
                  </span>
                  <span className="mg-choice__text">{p.description || 'A custom format.'}</span>
                  <span className="mg-chips">
                    {p.rules.rounds.map((r, i) => (
                      <RoundChip key={i} round={r} />
                    ))}
                  </span>
                </span>
                {!p.builtin && (
                  <button type="button" className="mg-tool mg-tool--bad mg-choice__del" aria-label={`Delete format ${p.name}`} onClick={() => void deletePreset(p)}>
                    ✕
                  </button>
                )}
              </label>
            ))}
          </div>
        </section>

        <section className="mg-section">
          <div className="mg-section__head">
            <h2>
              <span className="mg-step">2</span> Questions
            </h2>
            <Link href="/host/packs" className="mg-link">
              Manage packs
            </Link>
          </div>
          {packs.length ? (
            <div className="mg-grid" role="group" aria-label="Question packs">
              {packs.map((p) => (
                <label key={p.id} className="mg-choice">
                  <input type="checkbox" checked={packIds.includes(p.id)} onChange={() => togglePack(p.id)} />
                  <span className="mg-choice__body">
                    <span className="mg-choice__title">{p.title}</span>
                    <span className="mg-choice__text" title={p.description || undefined}>
                      {p.description || 'No description yet.'}
                    </span>
                    <span className="mg-chips">
                      <span className="mg-chip">{plural(p.categoryCount, 'category', 'categories')}</span>
                      <span className="mg-chip">{plural(p.surveyCount, 'survey')}</span>
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className="bz-card mg-empty mg-empty--inline">
              <p>No question packs yet.</p>
              <Link href="/host/packs" className="bz-btn bz-btn--primary">
                Create or import a pack
              </Link>
            </div>
          )}
        </section>
      </div>

      <div className="mg-setup__more">
        <details className="bz-card mg-fold">
          <summary>
            <span>
              <strong>Customise rules</strong>
              <small>Rounds, timers, penalties, steals, teams.</small>
            </span>
          </summary>
          <div className="mg-fold__body">
            <RulesEditor rules={rules} onChange={changeRules} />
            <div className="mg-row">
              <Button variant="ghost" size="s" disabled={!parsed.success} onClick={() => setSaving(true)}>
                Save as a format
              </Button>
              {customised && preset && (
                <Button variant="ghost" size="s" onClick={() => choosePreset(preset)}>
                  Reset to {preset.name}
                </Button>
              )}
            </div>
          </div>
        </details>

        <details className="bz-card mg-fold" onToggle={(e) => setPicking(e.currentTarget.open)}>
          <summary>
            <span>
              <strong>Hand-pick the questions</strong>
              <small>{picks.some((p) => p?.length) ? 'Some rounds are hand-picked. The rest are drawn at random.' : 'Every round is drawn at random from the selected packs.'}</small>
            </span>
          </summary>
          <div className="mg-fold__body">
            {packIds.every((id) => full[id]) ? (
              <PicksEditor rules={rules} packs={packIds.map((id) => full[id])} picks={picks} onChange={setPicks} />
            ) : (
              <i className="bz-spinner" aria-hidden />
            )}
          </div>
        </details>
      </div>

      <div className="mg-dock">
        <div className="mg-dock__inner">
          <div className="mg-dock__check" aria-live="polite">
            {blocker ? (
              <p className="mg-dock__blocker">{blocker}</p>
            ) : (
              <>
                <Tally label="categories" need={need.categories} have={have.categories} />
                <Tally label="surveys" need={need.surveys} have={have.surveys} />
              </>
            )}
            {error && (
              <p className="mg-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" variant="primary" size="l" disabled={!!blocker || busy}>
            {busy ? 'Setting up…' : rematch ? 'Start next game' : 'Create game'}
          </Button>
        </div>
      </div>

      {saving && parsed.success && (
        <SavePreset
          rules={parsed.data}
          onClose={() => setSaving(false)}
          onSaved={(saved) => {
            setPresets([...presets, saved]);
            setPresetId(saved.id);
            setRules(saved.rules);
            setSaving(false);
            toast(`Saved “${saved.name}”`, 'good');
          }}
        />
      )}
    </form>
  );
}

function RoundChip({ round }: { round: RoundDef }) {
  const detail =
    round.mode === 'trivia'
      ? `${round.categories}×${round.cluesPerCategory}${round.valueMultiplier > 1 ? ` · ×${round.valueMultiplier}` : ''}`
      : round.mode === 'fastMoney'
        ? `${round.questions} Q`
        : 'wager';
  return (
    <span className="mg-chip">
      <span aria-hidden>{MODE_ICON[round.mode]}</span> {round.title} <em>{detail}</em>
    </span>
  );
}

function Tally({ label, need, have }: { label: string; need: number; have: number }) {
  if (!need) return null;
  return (
    <span className={cx('bz-pill', have >= need ? 'bz-pill--good' : 'bz-pill--bad')}>
      {have >= need ? '✓' : '✕'} uses {need} of {have} {label}
    </span>
  );
}

function SavePreset({ rules, onClose, onSaved }: { rules: GameRules; onClose: () => void; onSaved: (p: Preset) => void }) {
  const { fail } = useShell();
  const [name, setName] = useState(rules.name);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      onSaved(await api.savePreset({ name: name.trim(), description: description.trim(), rules }));
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Save as a format" onClose={onClose}>
      <div className="mg-stack">
        <label className="bz-field">
          <span>Name</span>
          <input className="bz-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())} />
        </label>
        <label className="bz-field">
          <span>Description</span>
          <input className="bz-input" value={description} maxLength={200} placeholder="What makes this format fun?" onChange={(e) => setDescription(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save())} />
        </label>
        {error && (
          <p className="mg-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="bz-modal__actions">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void save()}>
          Save format
        </Button>
      </div>
    </Modal>
  );
}

/** Per round: leave it random, or tick the categories / surveys to use. Anything left unticked is filled at random. */
function PicksEditor({ rules, packs, picks, onChange }: { rules: GameRules; packs: Pack[]; picks: Picks; onChange: (p: Picks) => void }) {
  // The same id can appear in two packs (a duplicated pack); offer it once.
  const unique = <T extends { id: string }>(items: T[]) => items.filter((x, i) => items.findIndex((y) => y.id === x.id) === i);
  const categories = unique(packs.flatMap((p) => p.categories)).map((c) => ({ id: c.id, label: c.title }));
  const surveys = unique(packs.flatMap((p) => p.surveys)).map((s) => ({ id: s.id, label: s.question }));

  const toggle = (round: number, id: string, max: number) => {
    const current = picks[round] ?? [];
    const next = current.includes(id) ? current.filter((x) => x !== id) : max === 1 ? [id] : current.length < max ? [...current, id] : current;
    onChange(rules.rounds.map((_, i) => (i === round ? (next.length ? next : null) : (picks[i] ?? null))));
  };

  return (
    <div className="mg-stack">
      {rules.rounds.map((round, i) => {
        const items = round.mode === 'fastMoney' ? surveys : categories;
        const max = drawCount(round);
        const mine = picks[i] ?? [];
        const taken = new Set(picks.flatMap((p, k) => (k === i ? [] : (p ?? []))));
        const noun = round.mode === 'fastMoney' ? 'survey' : 'category';
        return (
          <fieldset key={i} className="mg-picks">
            <legend>
              <span aria-hidden>{MODE_ICON[round.mode]}</span> {round.title}
              <span className={cx('bz-pill', mine.length ? 'bz-pill--buzz' : '')}>{mine.length ? `${mine.length} of ${max} picked` : 'random'}</span>
              {mine.length > 0 && (
                <button type="button" className="mg-link" onClick={() => onChange(rules.rounds.map((_, k) => (k === i ? null : (picks[k] ?? null))))}>
                  Back to random
                </button>
              )}
            </legend>
            <div className="mg-picks__list">
              {items.map((item) => {
                const on = mine.includes(item.id);
                const off = !on && (taken.has(item.id) || (max > 1 && mine.length >= max));
                return (
                  <label key={item.id} className="mg-pick" data-on={on || undefined} data-off={off || undefined}>
                    <input type="checkbox" checked={on} disabled={off} onChange={() => toggle(i, item.id, max)} />
                    <span>{item.label}</span>
                  </label>
                );
              })}
              {!items.length && <p className="mg-muted">The selected packs have no {noun === 'survey' ? 'surveys' : 'categories'}.</p>}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}
