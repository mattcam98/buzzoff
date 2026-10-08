# Architecture

One Node process, one Postgres database, one React app. The server owns every
game; browsers render what they are sent and ask the server to do things.

```
 host laptop ─┐                       ┌─ packages/shared ──────────────┐
 TV screen ───┼── WebSocket ── Room ──┤ engine: pure state machine     │
 phones ──────┘   (Socket.IO)   │     │ schemas: every message, typed  │
                                │     └────────────────────────────────┘
        HTTP API ── packs, presets, join, history
                                │
                            Postgres (JSONB snapshots)
```

## The engine (`packages/shared/src/engine`)

The game is a pure function: `(state, action, clock) → new state + events`. It
reads no clock, makes no random numbers and touches no network; those arrive
as arguments. That is why the buzzer and every transition can be unit-tested
with a fake clock, and why the same code could run anywhere.

```
lobby ──start──▶ round ─────────────────▶ standings ──next──▶ round … ──▶ finished
                 intro ▸ (mode plays) ▸ done
```

Each mode is a module implementing one interface (`Mode` in `core.ts`): begin,
handle a host action, handle a player action, tick, list deadlines, pause
behaviour, and three views. The top-level game (`game.ts`) knows nothing about
any mode beyond that interface.

| Mode | Stages |
|---|---|
| `trivia` | board → reading → open → answering → result → board. A wrong answer loops back to *open* for a steal; a wager clue goes wager → answering. |
| `final` | wager → answering → reveal (show an answer, host rules, repeat). |
| `fastMoney` | ready → answering, per turn; then reveal (answer, then points, per cell) → result. |

**Adding a mode** — say, an elimination round:

1. Add its settings schema to `rules.ts` and its state to `state.ts`.
2. Implement `Mode` in `engine/elimination.ts`.
3. Register it in the `MODES` table in `game.ts`.
4. Add its public, host and player view types to `views.ts`, a scene to the
   TV, a panel to the phone and a stage to the host console.

Nothing in the existing modes, the room, the transport or the database
changes. The `final` mode was added exactly this way after trivia and Fast
Money were finished.

**Time.** The server's clock is `performance.timeOrigin + performance.now()`:
monotonic within a process (buzz order can never be disturbed by a clock
adjustment) and epoch-aligned (clients can render deadlines). The engine keeps
deadlines in state and reports the next one; the room holds a single timer
pointed at it. Pausing interrupts anything that depends on continuous time —
armed buzzers go back to "reading" — and resuming shifts every stored deadline
by the length of the pause.

## The room (`apps/server/src/room.ts`)

Everything around the engine that is not game logic: sockets, credentials, the
undo history, the timer, persistence, connection quality.

- **Concurrency.** Node runs the room on one thread and every change passes
  through one `commit` function, so transitions apply one at a time in arrival
  order. Two buzzes in the same millisecond are two sequential function calls;
  the second finds a winner already recorded. There are no locks because there
  is nothing to race.
- **Buzzes.** The handler takes the timestamp before doing anything else and
  passes it to the engine. The payload is empty: the only inputs are who sent
  it (from the authenticated socket) and when it arrived.
- **Idempotency.** Actions travel in an envelope with a client-generated id.
  The room remembers recent ids and acknowledges a repeat without applying it,
  so the client can safely retry when an acknowledgement is lost. Beyond that,
  every transition is guarded by the current stage: a second "correct" finds
  nobody answering and is rejected.
- **Undo.** State is immutable, so the room keeps the previous state before
  each significant host step (the last 40). Undo restores one, keeps today's
  roster and connections, and gives timers back the time they had left.
- **Connection quality.** The server sends a probe every 2.5 s and times the
  acknowledgement on its own clock, keeping the median of the last seven.

## Views and secrecy

After every change the room computes three things from the state
(`views.ts`):

- `PublicView` → TV, spectators and every phone. Built field by field; an
  answer appears in it only once it is on screen. Tests assert that no public
  or player view ever contains an unrevealed answer, an accepted alternative
  or a host note.
- `HostView` → the host socket only: answers, typed Fast Money responses,
  which clues hide wagers.
- `PlayerView` → one phone: whether *this* player may buzz and why not, their
  wager prompt, their own typed answers. Resent only when it changes.

Views are full snapshots with a sequence number, not patches. A board of fifty
clues is a few kilobytes, a reconnecting client needs no replay, and a client
cannot drift out of sync. One-shot `event` messages (a buzz, a ruling, a cue)
drive sound and animation only; missing one never leaves a screen wrong.

## Security model

| Who | Proves it with | Can do |
|---|---|---|
| Admin | `BUZZOFF_ADMIN_PASSWORD` → an HMAC-signed, expiring token | Create games, read and edit packs and presets, view history |
| Host of a game | A 256-bit host key returned once at creation and kept in that browser | Everything in that room |
| Player | A token issued on joining and kept on that phone | Buzz and act as that one player |
| TV / spectator | The room code | Receive the public view; send nothing |

- A socket's role is fixed at the handshake after its credential is checked.
  Host handlers are not attached to player sockets at all, so a forged host
  message from a phone has no listener.
- Every incoming message is parsed with a zod schema before the engine sees it.
- Only hashes of keys and tokens are stored. A new token for a player (after a
  takeover is approved) invalidates the old one.
- Room codes are four letters from a twenty-letter alphabet with no vowels and
  no look-alikes (160,000 codes), checked against live rooms. Joining and
  password attempts are rate-limited per address; each socket has its own
  message budget.
- Uploads are identified by their leading bytes, not their name, and stored
  under random names. SVG and HTML are not accepted. A content security policy
  allows scripts from the server itself only.
- With no admin password set, anyone who can reach the server can host and can
  read packs, answers included. The server logs a warning and the dashboard
  says so.

## Persistence

Postgres holds five tables: `packs`, `presets`, `games`, `results`,
`settings`. Each row's payload is a JSONB document, because each is always
read and written whole and the zod schemas in `packages/shared` are the
source of truth for their shape.

A live game is saved as one row (state and credential hashes together, in one
statement) shortly after each change, with writes chained so an older snapshot
can never overwrite a newer one, and flushed on shutdown. On boot every saved
game is restored paused, with buzzers disarmed and all players marked offline
until their phones reconnect — which they do on their own, with their stored
tokens.

A crash can lose at most the last quarter-second of changes. Undo history is
kept in memory only and does not survive a restart.

Redis is not used. One process holds all rooms in memory, which is the right
size for a house full of people. Running several server processes would need
sticky routing by room code or a shared room store; the room boundary
(`Room`, `Rooms`, `Store`) is where that would go.

## Web app (`apps/web`)

A single-page React app with four surfaces that share a design system
(`styles/base.css`) and a connection layer (`lib/connection.ts`):

| Route | Surface |
|---|---|
| `/`, `/join/CODE` | Join |
| `/play/CODE`, `/watch/CODE` | Phone controller, spectator |
| `/tv/CODE` | Shared screen, sized entirely from the viewport so it fills any display |
| `/host`, `/host/new`, `/host/packs`, `/host/history` | Dashboard |
| `/host/game/CODE` | Live console |

**Phone layout.** The join and controller screens sit in a fixed shell
(`.bz-app`) that never scrolls as a page. `lib/viewport.ts` publishes the
height and offset of the *visual* viewport as CSS variables, because that is
the only measure that follows the on-screen keyboard in iOS Safari (which
neither resizes the layout viewport nor supports `interactive-widget`; on
Android the viewport meta tag makes the page resize instead). The shell is a
size container, and the stylesheets respond to the space available with
container queries and `clamp()` sizes in container units rather than to
device widths: *short*, *tight* (keyboard open or landscape) and *wide*
(two columns). Long lists are the only scrolling regions, marked
`data-scroll`. `e2e/fit.ts` measures every phone screen at nine viewport
sizes and three keyboard heights and fails on page scroll, overflow, clipped
or overlapping elements, anything off screen, or touch targets under 28px.

The buzzer listens for `pointerdown`, which fires when a finger touches the
glass, rather than `click`, which fires when it lifts. Host keyboard shortcuts
work by clicking the on-screen button that carries the key, so a shortcut can
never do something the visible controls would not allow.

## Tests

| Layer | What it covers |
|---|---|
| Engine unit tests (`packages/shared`) | Buzz ordering, ties, duplicates, early-buzz lockouts, latency adjustment, scoring, steals, wagers, round flow, eliminations, pause, undo, restart recovery, Fast Money matching and reveal order, the final, answer secrecy |
| Server integration tests (`apps/server`) | Real sockets and HTTP against a real server: sync across host, TV and phones; twelve simultaneous buzzers; repeated messages; forged roles and malformed input; password gate and throttling; reconnect, takeover, kick; restart recovery; pack import and export; history and rematch |
| Browser tests (`e2e`) | A whole show in Chromium with a host, a TV and three phones; the dashboard; reload and wrong-device behaviour; every phone screen measured for fit across phone sizes, orientations and keyboard heights |

The server tests use the in-memory store. The Postgres store is exercised by
running the Compose stack.
