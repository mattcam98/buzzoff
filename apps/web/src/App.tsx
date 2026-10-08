import { normalizeRoomCode, ROOM_CODE_LENGTH } from '@buzzoff/shared';
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Redirect, Route, Switch } from 'wouter';
import { Button, Notice, Toasts } from './ui/kit';
import { Home } from './views/Home';
import { Play } from './views/Play';

/** Phones get the join screen and controller up front; the TV and the host's pages each load as one chunk when opened. */
function view<K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }));
}
const tv = () => import('./views/Tv');
const host = () => import('./views/host');
const Tv = view(tv, 'Tv');
const TvCodeEntry = view(tv, 'TvCodeEntry');
const HostConsole = view(host, 'HostConsole');
const HostHome = view(host, 'HostHome');
const History = view(host, 'History');
const NewGame = view(host, 'NewGame');
const PackEditor = view(host, 'PackEditor');
const Packs = view(host, 'Packs');
const Settings = view(host, 'Settings');

/** Room codes in URLs are normalised once, here, so every view can trust them. */
const code = (raw: string | undefined) => normalizeRoomCode(raw ?? '');

export function App() {
  return (
    <>
      <Crash>
        <Suspense fallback={<Notice title="Loading…" busy />}>
          <Switch>
            <Route path="/">{() => <Home />}</Route>
            <Route path="/join/:code">{(p) => <Home key={code(p.code)} code={code(p.code)} />}</Route>
            <Route path="/play/:code">{(p) => <Play key={code(p.code)} code={code(p.code)} />}</Route>
            <Route path="/watch/:code">{(p) => <Play key={code(p.code)} code={code(p.code)} spectator />}</Route>
            <Route path="/tv">{() => <TvCodeEntry />}</Route>
            <Route path="/tv/:code">{(p) => <Tv key={code(p.code)} code={code(p.code)} />}</Route>
            <Route path="/host">{() => <HostHome />}</Route>
            <Route path="/host/new">{() => <NewGame />}</Route>
            <Route path="/host/packs">{() => <Packs />}</Route>
            <Route path="/host/packs/:id">{(p) => <PackEditor key={p.id} id={p.id!} />}</Route>
            <Route path="/host/history">{() => <History />}</Route>
            <Route path="/host/settings">{() => <Settings />}</Route>
            <Route path="/host/game/:code">{(p) => <HostConsole key={code(p.code)} code={code(p.code)} />}</Route>
            {/* Typing just the code after the address should work too. */}
            <Route path="/:code">{(p) => (code(p.code).length === ROOM_CODE_LENGTH ? <Redirect to={`/join/${code(p.code)}`} /> : <NotFound />)}</Route>
            <Route>{() => <NotFound />}</Route>
          </Switch>
        </Suspense>
      </Crash>
      <Toasts />
    </>
  );
}

function NotFound() {
  return (
    <Notice title="Nothing here">
      <p>That page does not exist. Head back to the start to join or host a game.</p>
    </Notice>
  );
}

/** A rendering error would otherwise leave a blank page; a seat survives a reload, so offer one. */
class Crash extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError = () => ({ failed: true });
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Notice title="Something went wrong">
        <p>Reloading usually fixes it. Your place in the game is kept.</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </Notice>
    );
  }
}
