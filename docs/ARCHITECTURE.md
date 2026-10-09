# Architecture

One Node process, one Postgres database, one React app. The server owns every
game; browsers render what they are sent and ask the server to do things.

```
 host laptop ─┐                       ┌─ packages/shared ──────────────┐
 TV screen ───┼── WebSocket ── Room ──┤ engine: pure state machine     │
 phones ──────┘   (Socket.IO)   │     │ schemas: every message, typed  │
                                │     └────────────────────────────────┘
        HTTP API ── packs, presets, join, history, leaderboard
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
| `trivia` | roll → board → open → answering → result → board. The first board opens with a dice roll for the first pick (`engine/dice.ts`). Selecting a clue opens the buzzers; nobody arms them. A wrong answer loops back to *open* for a steal; a wager clue goes wager → answering. |
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
pointed at it. Randomness is an argument too: the room passes a generator
backed by the operating system's secure source, and every dice roll and
shuffle is drawn from it on the server. Pausing interrupts anything that depends on continuous time —
open buzzers are shut (the clue's *reading* stage, which exists only while
paused) — and resuming shifts every stored deadline by the length of the pause
and opens them again as a fresh buzz.

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
  The room remembers the ids of actions it has applied and acknowledges a
  repeat without applying it again, so the client can safely retry when an
  acknowledgement is lost; a rejected action is judged afresh. Beyond that,
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
  or a host note. The same mechanism hides the *question* while a buzz-in
  answer is being judged: it is simply not in the view, so no screen can show
  it, and it returns with the buzzers if the answer was wrong.
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
| Admin | The host password → a session token kept in that browser | Create games, read and edit packs and presets, view history, merge leaderboard entries, change settings |
| Host of a game | A 256-bit host key returned once at creation and kept in that browser | Everything in that room |
| Player | A token issued on joining and kept on that phone | Buzz, wager and answer as that one player. Never pick a clue: the board is the host's |
| TV / spectator | The room code | Receive the public view; send nothing |
| Anyone | Nothing | Read the leaderboard, if the host has made it public |

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
- With no host password set, anyone who can reach the server can host, read
  packs (answers included) and change settings, including setting the
  password. The server logs a warning and the dashboard says so.
  `BUZZOFF_ADMIN_PASSWORD` exists so a new server never has to start that way.

## Settings and sign-in

Configuration is split by when the server needs it. What it needs before it
can open the database, or that describes the machine and network around it
(port, database URL, media folder, trusted proxy count, log level), stays in
the environment. Everything an administrator might change while games are
running lives in the database and is edited at `/host/settings`:

- **`settings.ts`** holds one validated document (`AppSettingsSchema`): the
  players' address, the default format, how long games are kept, the upload
  limit and the session length. Readers always go through `settings.current`,
  so a save applies to the next request, upload or expiry sweep.
- **`auth.ts`** holds the host password as a scrypt hash (cost parameters
  stored with it) and the signed-in sessions. A session is a random 256-bit
  token; the database stores only its SHA-256. So nothing in the database can
  be used to sign in: there is no signing key to leak and nothing to decrypt,
  which is also why nothing here needs an encryption key in the environment.
- Changing the password requires the current one even from a signed-in
  browser, is throttled like signing in, and ends every session. Sessions can
  also be ended from the page ("sign out other devices") or all at once from
  the server with `reset-admin-password`.
- **The audit log** records sign-ins (failed ones included), password and
  session changes, and each settings change with its old and new value. It
  keeps the last 1,000 entries and never contains a password or token.
- The API returns settings and session metadata only: never the hash, and a
  session is identified to the browser by a label that cannot act as it.
- `TRUST_PROXY` deliberately stays out of reach of the page. It decides which
  address the sign-in throttle believes, so being able to change it from a
  signed-in browser would let a stolen session weaken the protection around
  the password.

The first time a server starts with no settings document, values from the
environment variables that used to hold them are imported, so upgrading
changes nothing; afterwards those variables are ignored.

## Persistence

Postgres holds seven tables: `packs`, `presets`, `games`, `results`,
`settings`, `admin_sessions` and `audit_log`. The first four hold a JSONB
document per row, because each is always read and written whole and the zod
schemas in `packages/shared` are the source of truth for their shape.

A live game is saved as one row (state and credential hashes together, in one
statement) shortly after each change, with writes chained so an older snapshot
can never overwrite a newer one, and flushed on shutdown. On boot every saved
game is restored paused, with buzzers shut and all players marked offline
until their phones reconnect — which they do on their own, with their stored
tokens.

A crash can lose at most the last quarter-second of changes. Undo history is
kept in memory only and does not survive a restart.

Redis is not used. One process holds all rooms in memory, which is the right
size for a house full of people. Running several server processes would need
sticky routing by room code or a shared room store; the room boundary
(`Room`, `Rooms`, `Store`) is where that would go.

## Results and the leaderboard

When a game finishes, the room writes one `GameResult` document (`stats.ts`):
who played, their scores, who won and each player's buzzer and answer
statistics. History shows those documents as they are. The leaderboard is the
same documents added up by a pure function, `buildLeaderboard` in
`packages/shared/src/leaderboard.ts`; nothing about it is stored, so there is
no second record to drift from the first. Removing a result, or undoing the
end of a game, changes the standings because it changes their only input.
`results.ts` on the server is the one door results go through, which lets it
keep the computed standings in memory until the next result is saved or
removed instead of reading the whole history for every request.

**Recognising players.** There are no accounts. `POST /games/:code/join`
gives a phone a random key in an `HttpOnly` cookie the first time it joins
(a server-set cookie outlives the script-writable storage that browsers clear
on their own) and renews it on every later join. The key is never stored: the
room keeps a truncated SHA-256 of it per seat, next to the seat's token hash
in the game's credentials rather than in the game state, so it cannot appear
in any view. `buildResult` copies it onto the result as `profileId`. Two
results with the same `profileId` are the same phone, whatever names were
typed.

What the cookie cannot know is settled in `leaderboard.ts`, in this order:

1. A seat with a `profileId` is that profile. A seat without one (a game from
   before this existed, or a browser that refused the cookie) is known by its
   name, compared the way the lobby compares names.
2. A bare name is taken to be a profile when exactly one profile has ever
   played under it and the two never met in a game.
3. The host's links (`PlayerLinks`, one JSON document in `settings`) override
   that: `from → into` merges two entries, and an identity linked to itself is
   kept apart from whatever its name would match.
4. Two seats in one game are never one person. If links say otherwise for a
   particular game, the second seat keeps its own identity there. A second
   seat on the same phone that never scored, buzzed or answered is one
   somebody joined and abandoned for another name, and is dropped.

**Ranking** (`rankPlayers`) orders the entries one way at a time: counts rank
everybody, rates rank only players above a minimum sample, equals share a rank.
It runs in the browser, on the entries the API returns, so changing the order
needs no request.

`GET /api/leaderboard` answers the host always and everyone else only when the
`publicLeaderboard` setting is on. It tells the caller which entry is theirs
(from the cookie) and leaves out, for anyone but the host, which identities
make up each entry.

## Web app (`apps/web`)

A single-page React app with five surfaces that share a design system
(`styles/base.css`) and a connection layer (`lib/connection.ts`). The design
system's surfaces are tokens in `base.css`: *glass* for cards and panels
(`.bz-card`), *tile* for repeated rows, *well* for recessed areas inside a
card, *bar* for sticky chrome and *scrim* for overlays. Components take their
background, border, blur and shadow from those rather than defining their
own, which is what keeps the dashboard, console, phone and TV looking alike. It is built
in pieces: the join screen and phone controller load first, and the TV, the
leaderboard and the host's pages each load as their own chunk when opened, so a phone
never downloads the dashboard, the pack editor or zod. `@buzzoff/shared` is
marked side-effect free and keeps what a phone needs (room codes, avatars,
statistics) out of the modules that define schemas, which is what lets the
bundler leave the rest behind.

| Route | Surface |
|---|---|
| `/`, `/join/CODE` | Join |
| `/play/CODE`, `/watch/CODE` | Phone controller, spectator |
| `/tv/CODE` | Shared screen, sized entirely from the viewport so it fills any display |
| `/host`, `/host/new`, `/host/packs`, `/host/history`, `/host/leaderboard`, `/host/settings` | Dashboard |
| `/leaderboard` | The standings as players see them, when the host has opened them |
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
| Leaderboard unit tests (`packages/shared`) | Totals, what counts as a game and as a win, recognising players by profile and by name, shared phones, host merges and their limits, ranking with ties and minimum samples |
| Engine unit tests (`packages/shared`) | Buzz ordering, ties, duplicates, the dice roll for the first pick, automatic opening, the hidden question and its held timer, latency adjustment, scoring, steals, wagers, round flow, eliminations, pause, undo, restart recovery, Fast Money matching and reveal order, the final, answer secrecy |
| Server integration tests (`apps/server`) | Real sockets and HTTP against a real server: sync across host, TV and phones; twelve simultaneous buzzers; repeated messages; forged roles and malformed input; password gate and throttling; settings import, validation and live effect; sessions, password changes and the audit log; reconnect, takeover, kick; restart recovery; pack import and export; history and rematch; the leaderboard across games, a returning phone under a new name, merging and separating players, who may see it |
| Browser tests (`e2e`) | A whole show in Chromium with a host, a TV and three phones; the dashboard; the Settings page from an open server to a locked one; reload and wrong-device behaviour; every phone screen measured for fit across phone sizes, orientations and keyboard heights |

The server tests use the in-memory store. The Postgres store is exercised by
running the Compose stack.
