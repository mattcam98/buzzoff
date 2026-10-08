import { normalizeRoomCode } from '@buzzoff/shared';
import { Redirect, Route, Switch } from 'wouter';
import { Notice, Toasts } from './ui/kit';
import { Home } from './views/Home';
import { Play } from './views/Play';
import { Tv, TvCodeEntry } from './views/Tv';
import { HostConsole } from './views/host/HostConsole';
import { HostHome } from './views/host/HostHome';
import { History } from './views/host/History';
import { NewGame } from './views/host/NewGame';
import { PackEditor } from './views/host/PackEditor';
import { Packs } from './views/host/Packs';

/** Room codes in URLs are normalised once, here, so every view can trust them. */
const code = (raw: string | undefined) => normalizeRoomCode(raw ?? '');

export function App() {
  return (
    <>
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
        <Route path="/host/game/:code">{(p) => <HostConsole key={code(p.code)} code={code(p.code)} />}</Route>
        {/* Typing just the code after the address should work too. */}
        <Route path="/:code">{(p) => (code(p.code).length === 4 ? <Redirect to={`/join/${code(p.code)}`} /> : <NotFound />)}</Route>
        <Route>{() => <NotFound />}</Route>
      </Switch>
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
