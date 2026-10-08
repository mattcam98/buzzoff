/**
 * The pack editor. Edits are held locally and written with an explicit Save,
 * so a half-typed clue never reaches a game.
 */
import { PackContentSchema, type Category, type Clue, type Media, type PackContent, type Survey, type SurveyAnswer } from '@buzzoff/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'wouter';
import { api, ApiFailure } from '../../lib/api';
import { plural } from '../../lib/format';
import { Button, cx, toast } from '../../ui/kit';
import { ListField, move, NumField, RowTools, shortId, ToggleField } from './fields';
import { HostShell, useShell } from './HostShell';

export function PackEditor({ id }: { id: string }) {
  return (
    <HostShell wide>
      <Editor id={id} />
    </HostShell>
  );
}

const blankClue = (value: number, difficulty?: number): Clue => ({ id: shortId(), value, difficulty, question: '', answer: '', accept: [] });
const blankCategory = (): Category => ({ id: shortId(), title: '', clues: [100, 200, 300, 400, 500].map((v, i) => blankClue(v, i + 1)) });
const blankAnswer = (): SurveyAnswer => ({ text: '', points: 0, aliases: [] });
const blankSurvey = (): Survey => ({ id: shortId(), question: '', answers: [blankAnswer(), blankAnswer(), blankAnswer(), blankAnswer()] });

/** Drop rows the author never filled in, so a spare blank clue does not block a save. */
function prune(draft: PackContent): PackContent {
  return {
    ...draft,
    categories: draft.categories.map((c) => ({ ...c, clues: c.clues.filter((k) => k.question.trim() || k.answer.trim()) })),
    surveys: draft.surveys.map((s) => ({ ...s, answers: s.answers.filter((a) => a.text.trim()) })),
  };
}

/** Say where a validation problem is in the author's terms rather than as a JSON path. */
function describeIssue(draft: PackContent, path: PropertyKey[], message: string): string {
  const [section, i, list, j, field] = path;
  const name = (title: string | undefined, fallback: string) => (title?.trim() ? `“${title.trim()}”` : fallback);
  const problem = (what: unknown, fallback: string) =>
    `the ${String(what ?? fallback)} ${/^Too small/.test(message) ? 'is empty' : /^Too big/.test(message) ? 'is too long' : `is not valid (${message})`}`;
  if (section === 'categories' && typeof i === 'number') {
    const where = `Category ${name(draft.categories[i]?.title, `#${i + 1}`)}`;
    if (list === 'clues' && typeof j === 'number') return `${where}, clue ${j + 1}: ${problem(field, 'clue')}`;
    if (list === 'clues') return `${where} needs at least one clue with a question and an answer`;
    return `${where}: ${problem(list, 'category')}`;
  }
  if (section === 'surveys' && typeof i === 'number') {
    const where = `Survey ${name(draft.surveys[i]?.question, `#${i + 1}`)}`;
    if (list === 'answers' && typeof j === 'number') return `${where}, answer ${j + 1}: ${problem(field, 'answer')}`;
    if (list === 'answers') return `${where} needs at least one answer`;
    return `${where}: ${problem(list, 'survey')}`;
  }
  return path.length ? `The pack’s ${problem(path.map(String).join(' › '), 'pack').slice(4)}` : message;
}

function Editor({ id }: { id: string }) {
  const { fail } = useShell();
  const [draft, setDraft] = useState<PackContent | null>(null);
  const [saved, setSaved] = useState('');
  const [missing, setMissing] = useState<string | null>(null);
  const [tab, setTab] = useState<'categories' | 'surveys'>('categories');
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.pack(id).then(
      ({ id: _id, createdAt: _c, updatedAt: _u, ...content }) => {
        if (cancelled) return;
        setDraft(content);
        setSaved(JSON.stringify(content));
        setOpen(content.categories.length === 1 ? content.categories[0].id : null);
      },
      (err) => !cancelled && setMissing(err instanceof ApiFailure && err.status === 404 ? 'That pack no longer exists.' : fail(err)),
    );
    return () => {
      cancelled = true;
    };
  }, [id, fail]);

  const dirty = !!draft && JSON.stringify(draft) !== saved;

  const save = useCallback(async () => {
    if (!draft || saving) return;
    const tidy = prune(draft);
    const check = PackContentSchema.safeParse(tidy);
    if (!check.success) {
      const issue = check.error.issues[0];
      if (issue.path[0] === 'surveys') setTab('surveys');
      else if (issue.path[0] === 'categories') {
        setTab('categories');
        setOpen(tidy.categories[issue.path[1] as number]?.id ?? null);
      }
      setDraft(tidy);
      return setError(describeIssue(tidy, issue.path, issue.message));
    }
    setSaving(true);
    setError(null);
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, ...content } = await api.savePack(id, check.data);
      setDraft(content);
      setSaved(JSON.stringify(content));
      toast('Pack saved', 'good');
    } catch (err) {
      setError(fail(err));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, id, fail]);

  // Guard unsaved work: closing the tab, following a link, and Ctrl/Cmd+S to save.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || link.getAttribute('target') === '_blank') return;
      if (!window.confirm('Leave without saving? Your changes to this pack will be lost.')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const counts = useMemo(
    () => (draft ? { clues: draft.categories.reduce((n, c) => n + c.clues.length, 0) } : { clues: 0 }),
    [draft],
  );

  if (missing) {
    return (
      <div className="mg-empty" role="alert">
        <h1>Pack not found</h1>
        <p>{missing}</p>
        <Link href="/host/packs" className="bz-btn bz-btn--primary">
          Back to packs
        </Link>
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="mg-empty">
        <i className="bz-spinner" aria-hidden />
      </div>
    );
  }

  const patch = (p: Partial<PackContent>) => setDraft({ ...draft, ...p });
  const setCategory = (i: number, c: Category) => patch({ categories: draft.categories.map((x, k) => (k === i ? c : x)) });
  const setSurvey = (i: number, s: Survey) => patch({ surveys: draft.surveys.map((x, k) => (k === i ? s : x)) });

  function addCategory() {
    const cat = blankCategory();
    patch({ categories: [...draft!.categories, cat] });
    setOpen(cat.id);
    setFocus(cat.id);
  }
  function addSurvey() {
    const survey = blankSurvey();
    patch({ surveys: [...draft!.surveys, survey] });
    setFocus(survey.id);
  }

  return (
    <div className="mg-editor">
      <div className="mg-savebar">
        <Link href="/host/packs" className="mg-link">
          ← Packs
        </Link>
        <span className={cx('bz-pill', dirty ? 'bz-pill--buzz' : 'bz-pill--good')} aria-live="polite">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>
        <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()} hotkey="⌘S">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {error && (
          <p className="mg-error mg-savebar__error" role="alert">
            {error}
          </p>
        )}
      </div>

      <section className="bz-card mg-meta">
        <label className="bz-field mg-meta__title">
          <span>Pack title</span>
          <input className="bz-input" value={draft.title} maxLength={80} placeholder="Friday Night Trivia" onChange={(e) => patch({ title: e.target.value })} />
        </label>
        <label className="bz-field">
          <span>Author</span>
          <input className="bz-input" value={draft.author} maxLength={80} placeholder="Optional" onChange={(e) => patch({ author: e.target.value })} />
        </label>
        <label className="bz-field mg-meta__wide">
          <span>Description</span>
          <textarea className="bz-textarea" rows={2} value={draft.description} maxLength={400} placeholder="What is this pack about?" onChange={(e) => patch({ description: e.target.value })} />
        </label>
      </section>

      <div className="mg-tabs" role="tablist" aria-label="Pack contents">
        <button type="button" role="tab" aria-selected={tab === 'categories'} onClick={() => setTab('categories')}>
          Trivia <span>{plural(draft.categories.length, 'category', 'categories')} · {plural(counts.clues, 'clue')}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'surveys'} onClick={() => setTab('surveys')}>
          Surveys <span>{plural(draft.surveys.length, 'question')}</span>
        </button>
      </div>

      {tab === 'categories' && (
        <section className="mg-stack" role="tabpanel">
          {draft.categories.length === 0 && (
            <div className="bz-card mg-empty mg-empty--inline">
              <p>No categories yet. A category is one column on the board: a theme and a handful of clues that get harder as the points go up.</p>
            </div>
          )}
          {draft.categories.map((cat, i) => (
            <CategoryCard
              key={cat.id}
              category={cat}
              index={i}
              count={draft.categories.length}
              open={open === cat.id}
              focus={focus}
              onFocusDone={() => setFocus(null)}
              onToggle={() => setOpen(open === cat.id ? null : cat.id)}
              onChange={(c) => setCategory(i, c)}
              onMove={(to) => patch({ categories: move(draft.categories, i, to) })}
              onRemove={() => {
                if (cat.clues.some((k) => k.question.trim()) && !window.confirm(`Remove “${cat.title || 'this category'}” and its ${plural(cat.clues.length, 'clue')}?`)) return;
                patch({ categories: draft.categories.filter((_, k) => k !== i) });
              }}
              requestFocus={setFocus}
            />
          ))}
          {draft.categories.length < 80 && (
            <Button variant="primary" onClick={addCategory}>
              + Add a category
            </Button>
          )}
        </section>
      )}

      {tab === 'surveys' && (
        <section className="mg-stack" role="tabpanel">
          {draft.surveys.length === 0 && (
            <div className="bz-card mg-empty mg-empty--inline">
              <p>No surveys yet. A survey is a “Name something…” question with several accepted answers, each worth points. The more popular the answer, the more it scores.</p>
            </div>
          )}
          {draft.surveys.map((survey, i) => (
            <SurveyCard
              key={survey.id}
              survey={survey}
              index={i}
              count={draft.surveys.length}
              autoFocus={focus === survey.id}
              onFocusDone={() => setFocus(null)}
              onChange={(s) => setSurvey(i, s)}
              onMove={(to) => patch({ surveys: move(draft.surveys, i, to) })}
              onRemove={() => {
                if (survey.question.trim() && !window.confirm('Remove this survey question?')) return;
                patch({ surveys: draft.surveys.filter((_, k) => k !== i) });
              }}
            />
          ))}
          {draft.surveys.length < 80 && (
            <Button variant="primary" onClick={addSurvey}>
              + Add a survey question
            </Button>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- categories

interface CategoryProps {
  category: Category;
  index: number;
  count: number;
  open: boolean;
  focus: string | null;
  onFocusDone: () => void;
  requestFocus: (id: string) => void;
  onToggle: () => void;
  onChange: (c: Category) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function CategoryCard({ category: cat, index, count, open, focus, onFocusDone, requestFocus, onToggle, onChange, onMove, onRemove }: CategoryProps) {
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus === cat.id && open) {
      title.current?.focus();
      onFocusDone();
    }
  }, [focus, cat.id, open, onFocusDone]);

  const setClue = (i: number, clue: Clue) => onChange({ ...cat, clues: cat.clues.map((c, k) => (k === i ? clue : c)) });
  function addClue() {
    const last = cat.clues[cat.clues.length - 1];
    const step = cat.clues.length > 1 ? last.value - cat.clues[cat.clues.length - 2].value : 100;
    const clue = blankClue(last ? last.value + (step > 0 ? step : 100) : 100, Math.min(5, cat.clues.length + 1));
    onChange({ ...cat, clues: [...cat.clues, clue] });
    requestFocus(clue.id);
  }
  const filled = cat.clues.filter((c) => c.question.trim() && c.answer.trim()).length;

  return (
    <article className="bz-card mg-cat" data-open={open || undefined}>
      <header className="mg-cat__head">
        <button type="button" className="mg-cat__toggle" aria-expanded={open} onClick={onToggle}>
          <span className="mg-cat__caret" aria-hidden>
            ▸
          </span>
          <span className="mg-cat__name">{cat.title.trim() || 'Untitled category'}</span>
          <span className="mg-chip">
            {filled}/{cat.clues.length} clues
          </span>
          {cat.singleAttempt && <span className="bz-pill bz-pill--cyan">no steals</span>}
        </button>
        <RowTools index={index} count={count} what={cat.title || 'category'} onMove={onMove} onRemove={onRemove} />
      </header>

      {open && (
        <div className="mg-cat__body">
          <div className="mg-cat__meta">
            <label className="bz-field">
              <span>Category title</span>
              <input ref={title} className="bz-input" value={cat.title} maxLength={60} placeholder="Around the World" onChange={(e) => onChange({ ...cat, title: e.target.value })} />
              <small>Short titles fit the board best — aim for under 22 characters.</small>
            </label>
            <label className="bz-field">
              <span>Blurb</span>
              <input className="bz-input" value={cat.blurb ?? ''} maxLength={160} placeholder="A one-line teaser (optional)" onChange={(e) => onChange({ ...cat, blurb: e.target.value || undefined })} />
            </label>
            <ToggleField
              label="Single attempt (no steals)"
              checked={!!cat.singleAttempt}
              onChange={(singleAttempt) => onChange({ ...cat, singleAttempt: singleAttempt || undefined })}
              help="For either/or questions: only the first buzzer may answer."
            />
          </div>

          <ol className="mg-clues">
            {cat.clues.map((clue, i) => (
              <ClueRow
                key={clue.id}
                clue={clue}
                index={i}
                count={cat.clues.length}
                autoFocus={focus === clue.id}
                onFocusDone={onFocusDone}
                onChange={(c) => setClue(i, c)}
                onMove={(to) => onChange({ ...cat, clues: move(cat.clues, i, to) })}
                onRemove={() => onChange({ ...cat, clues: cat.clues.filter((_, k) => k !== i) })}
                onNext={() => {
                  const next = cat.clues[i + 1];
                  if (next) requestFocus(next.id);
                  else if (cat.clues.length < 10) addClue();
                }}
              />
            ))}
          </ol>
          {cat.clues.length < 10 && (
            <Button variant="ghost" size="s" onClick={addClue}>
              + Add a clue
            </Button>
          )}
        </div>
      )}
    </article>
  );
}

interface ClueProps {
  clue: Clue;
  index: number;
  count: number;
  autoFocus: boolean;
  onFocusDone: () => void;
  onChange: (c: Clue) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  /** Enter in the answer field: go to the next clue, or start a new one. */
  onNext: () => void;
}

function ClueRow({ clue, index, count, autoFocus, onFocusDone, onChange, onMove, onRemove, onNext }: ClueProps) {
  const question = useRef<HTMLTextAreaElement>(null);
  const answer = useRef<HTMLInputElement>(null);
  const extras = clue.accept.length + (clue.notes ? 1 : 0) + (clue.media ? 1 : 0);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!autoFocus) return;
    question.current?.focus();
    question.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    onFocusDone();
  }, [autoFocus, onFocusDone]);

  const enter = (go: () => void) => (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    go();
  };

  return (
    <li className="mg-clue">
      <div className="mg-clue__main">
        <NumField className="mg-clue__value" label="Points" value={clue.value} min={0} max={1000000} step={100} onChange={(value) => onChange({ ...clue, value })} />
        <label className="bz-field mg-clue__q">
          <span>Question {index + 1}</span>
          <textarea
            ref={question}
            className="bz-textarea"
            rows={2}
            value={clue.question}
            maxLength={600}
            placeholder="Read aloud by the host"
            onChange={(e) => onChange({ ...clue, question: e.target.value })}
            onKeyDown={enter(() => answer.current?.focus())}
          />
        </label>
        <label className="bz-field mg-clue__a">
          <span>Answer</span>
          <input
            ref={answer}
            className="bz-input"
            value={clue.answer}
            maxLength={300}
            placeholder="The correct answer"
            enterKeyHint="next"
            onChange={(e) => onChange({ ...clue, answer: e.target.value })}
            onKeyDown={enter(onNext)}
          />
        </label>
        <div className="mg-clue__tools">
          <button type="button" className="mg-link" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Less' : 'More'}
            {extras > 0 && !more && <span className="mg-dot" aria-label={`${extras} extra details`} />}
          </button>
          <RowTools index={index} count={count} what={`clue ${index + 1}`} onMove={onMove} onRemove={count > 1 ? onRemove : undefined} />
        </div>
      </div>

      {more && (
        <div className="mg-clue__more">
          <label className="bz-field">
            <span>Difficulty</span>
            <select className="bz-select" value={clue.difficulty ?? ''} onChange={(e) => onChange({ ...clue, difficulty: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Not set</option>
              {['1 · easiest', '2', '3', '4', '5 · hardest'].map((label, i) => (
                <option key={i} value={i + 1}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <ListField by="line" label="Also accept" value={clue.accept} onChange={(accept) => onChange({ ...clue, accept })} placeholder="One alternative per line" help="Shown to the host while judging." />
          <label className="bz-field">
            <span>Host notes</span>
            <textarea className="bz-textarea" rows={2} value={clue.notes ?? ''} maxLength={600} placeholder="Pronunciation, a fun fact…" onChange={(e) => onChange({ ...clue, notes: e.target.value || undefined })} />
          </label>
          <MediaField media={clue.media} onChange={(media) => onChange({ ...clue, media })} />
        </div>
      )}
    </li>
  );
}

function MediaField({ media, onChange }: { media: Media | undefined; onChange: (m: Media | undefined) => void }) {
  const { fail } = useShell();
  const file = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<Media['kind']>('image');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(f: File) {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.uploadMedia(f));
    } catch (err) {
      setError(fail(err));
    } finally {
      setBusy(false);
    }
  }
  function addUrl() {
    const value = url.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) return setError('Paste a full link starting with http:// or https://');
    setError(null);
    setUrl('');
    onChange({ kind, url: value });
  }

  return (
    <div className="bz-field mg-media">
      <span className="bz-label">Picture, sound or video</span>
      {media ? (
        <div className="mg-media__has">
          {media.kind === 'image' && <img src={media.url} alt="Clue media preview" />}
          {media.kind === 'audio' && <audio src={media.url} controls preload="none" />}
          {media.kind === 'video' && <video src={media.url} controls preload="metadata" />}
          <span className="mg-media__info">
            <span className="bz-pill">{media.kind}</span>
            <span className="mg-media__url">{media.url}</span>
          </span>
          <Button size="s" variant="ghost" onClick={() => onChange(undefined)}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="mg-media__add">
          <input
            ref={file}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label="Upload a media file"
            accept="image/png,image/jpeg,image/gif,image/webp,audio/*,video/mp4,video/webm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
          <Button size="s" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'Uploading…' : 'Upload a file'}
          </Button>
          <span className="mg-muted">or</span>
          <select className="bz-select mg-media__kind" aria-label="Media type for the link" value={kind} onChange={(e) => setKind(e.target.value as Media['kind'])}>
            <option value="image">Image</option>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
          </select>
          <input
            className="bz-input mg-media__link"
            aria-label="Media link"
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addUrl())}
          />
          <Button size="s" variant="ghost" disabled={!url.trim()} onClick={addUrl}>
            Add link
          </Button>
        </div>
      )}
      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- surveys

interface SurveyProps {
  survey: Survey;
  index: number;
  count: number;
  autoFocus: boolean;
  onFocusDone: () => void;
  onChange: (s: Survey) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}

function SurveyCard({ survey, index, count, autoFocus, onFocusDone, onChange, onMove, onRemove }: SurveyProps) {
  const question = useRef<HTMLInputElement>(null);
  const [focusAnswer, setFocusAnswer] = useState<number | null>(null);
  useEffect(() => {
    if (!autoFocus) return;
    question.current?.focus();
    question.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    onFocusDone();
  }, [autoFocus, onFocusDone]);

  const total = survey.answers.reduce((n, a) => n + (a.points || 0), 0);
  const setAnswer = (i: number, a: SurveyAnswer) => onChange({ ...survey, answers: survey.answers.map((x, k) => (k === i ? a : x)) });
  function addAnswer() {
    onChange({ ...survey, answers: [...survey.answers, blankAnswer()] });
    setFocusAnswer(survey.answers.length);
  }

  return (
    <article className="bz-card mg-survey">
      <header className="mg-survey__head">
        <label className="bz-field">
          <span>Survey question {index + 1}</span>
          <input ref={question} className="bz-input" value={survey.question} maxLength={240} placeholder="Name something people do first thing in the morning" onChange={(e) => onChange({ ...survey, question: e.target.value })} />
        </label>
        <RowTools index={index} count={count} what={`survey ${index + 1}`} onMove={onMove} onRemove={onRemove} />
      </header>

      <ol className="mg-answers">
        {survey.answers.map((a, i) => (
          // Keyed by list length too, so rows re-read their text after an answer is removed.
          <li key={`${survey.answers.length}-${i}`} className="mg-answer">
            <span className="mg-answer__rank bz-num" aria-hidden>
              {i + 1}
            </span>
            <label className="bz-field mg-answer__text">
              <span>Answer</span>
              <input
                className="bz-input"
                value={a.text}
                maxLength={80}
                placeholder="Brush teeth"
                ref={(el) => {
                  if (el && focusAnswer === i) {
                    el.focus();
                    setFocusAnswer(null);
                  }
                }}
                onChange={(e) => setAnswer(i, { ...a, text: e.target.value })}
              />
            </label>
            <NumField className="mg-answer__points" label="Points" value={a.points} min={0} max={1000} onChange={(points) => setAnswer(i, { ...a, points })} />
            <div className="mg-answer__aliases">
              <ListField by="comma" label="Also counts" value={a.aliases} onChange={(aliases) => setAnswer(i, { ...a, aliases })} placeholder="brushing teeth, toothbrush" />
            </div>
            <button
              type="button"
              className="mg-tool mg-tool--bad"
              aria-label={`Remove answer ${i + 1}`}
              title="Remove answer"
              disabled={survey.answers.length <= 1}
              onClick={() => onChange({ ...survey, answers: survey.answers.filter((_, k) => k !== i) })}
            >
              ✕
            </button>
          </li>
        ))}
      </ol>

      <footer className="mg-survey__foot">
        {survey.answers.length < 12 && (
          <Button variant="ghost" size="s" onClick={addAnswer}>
            + Add an answer
          </Button>
        )}
        <span className={cx('bz-pill', total > 100 ? 'bz-pill--bad' : total >= 90 ? 'bz-pill--good' : '')}>{total} points in total</span>
        <small className="mg-muted">A classic survey adds up to about 100.</small>
      </footer>
    </article>
  );
}
