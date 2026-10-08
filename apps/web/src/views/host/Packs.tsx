/** The pack library: create, import, export, duplicate and delete question packs. */
import type { PackSummary } from '@buzzoff/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../../lib/api';
import { plural } from '../../lib/format';
import { Button, toast } from '../../ui/kit';
import { HostShell, PageHead, useShell } from './HostShell';

export function Packs() {
  return (
    <HostShell>
      <Library />
    </HostShell>
  );
}

const fileName = (title: string) => `${title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'pack'}.buzzoff.json`;

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const edited = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function Library() {
  const { fail } = useShell();
  const [, navigate] = useLocation();
  const [packs, setPacks] = useState<PackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = useCallback(
    () =>
      api.packs().then(setPacks, (err) => {
        setPacks([]);
        setError(fail(err));
      }),
    [fail],
  );
  useEffect(() => void reload(), [reload]);

  /** Run one library action, surfacing any failure and refreshing the list. */
  async function run(action: () => Promise<unknown>, done?: string, failed?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (done) toast(done, 'good');
      await reload();
    } catch (err) {
      setError(failed ? `${failed} — ${fail(err)}` : fail(err));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    try {
      const pack = await api.createPack({ title: 'Untitled pack', description: '', author: '', categories: [], surveys: [] });
      navigate(`/host/packs/${pack.id}`);
    } catch (err) {
      setError(fail(err));
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return setError(`“${file.name}” is not a JSON file. Export a pack from BuzzOff to see the expected format.`);
    }
    await run(() => api.importPack(parsed), `Imported “${file.name}”`, `“${file.name}” is not a valid BuzzOff pack`);
  }

  const duplicate = (pack: PackSummary) =>
    run(async () => {
      const file = await api.exportPack(pack.id);
      await api.importPack({ ...file, pack: { ...file.pack, title: `${file.pack.title} (copy)`.slice(0, 80) } });
    }, `Duplicated “${pack.title}”`);

  const remove = (pack: PackSummary) => {
    if (!window.confirm(`Delete “${pack.title}”? Games already created from it are not affected.`)) return;
    void run(() => api.deletePack(pack.id), `Deleted “${pack.title}”`);
  };

  return (
    <>
      <PageHead eyebrow="Content" title="Question packs" lead="A pack is a pool of trivia categories and survey questions. Any format can draw from any pack.">
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          aria-label="Import a pack file"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />
        <Button variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}>
          Import
        </Button>
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          New pack
        </Button>
      </PageHead>

      {error && (
        <p className="mg-error" role="alert">
          {error}
        </p>
      )}

      {packs === null ? (
        <div className="mg-empty">
          <i className="bz-spinner" aria-hidden />
        </div>
      ) : packs.length === 0 ? (
        <div className="bz-card mg-empty bz-rise">
          <span className="mg-empty__icon" aria-hidden>
            🗂️
          </span>
          <h2>No packs yet</h2>
          <p>Start a pack of your own, or import a .buzzoff.json file someone shared with you.</p>
          <Button variant="primary" disabled={busy} onClick={() => void create()}>
            Write your first pack
          </Button>
        </div>
      ) : (
        <ul className="mg-grid mg-grid--packs">
          {packs.map((pack) => (
            <li key={pack.id} className="bz-card mg-pack">
              <Link href={`/host/packs/${pack.id}`} className="mg-pack__main">
                <h2>{pack.title}</h2>
                <p>{pack.description || 'No description yet.'}</p>
                <span className="mg-chips">
                  <span className="mg-chip">{plural(pack.categoryCount, 'category', 'categories')}</span>
                  <span className="mg-chip">{plural(pack.clueCount, 'clue')}</span>
                  <span className="mg-chip">{plural(pack.surveyCount, 'survey')}</span>
                </span>
                <small>
                  {pack.author ? `By ${pack.author} · ` : ''}edited {edited(pack.updatedAt)}
                </small>
              </Link>
              <div className="mg-pack__actions">
                <Link href={`/host/packs/${pack.id}`} className="bz-btn bz-btn--s">
                  Edit
                </Link>
                <Button size="s" variant="ghost" disabled={busy} onClick={() => void run(async () => download(fileName(pack.title), await api.exportPack(pack.id)))}>
                  Export
                </Button>
                <Button size="s" variant="ghost" disabled={busy} onClick={() => void duplicate(pack)}>
                  Duplicate
                </Button>
                <Button size="s" variant="ghost" icon disabled={busy} aria-label={`Delete ${pack.title}`} title="Delete" onClick={() => remove(pack)}>
                  ✕
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
