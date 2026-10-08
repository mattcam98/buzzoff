# BuzzOff

A self-hosted quiz show for a room full of friends. One person hosts from a
laptop, the game goes up on the TV, and everyone else plays from their phone by
typing a four-letter room code. No accounts, no app.

It plays a full show out of the box: two trivia boards with a hidden wager on
each, a written final everyone bets on, and a head-to-head Fast Money decider.
The format is modelled on the episode structure of Ludwig Ahgren's *Mogul
Money* (see [docs/RESEARCH.md](docs/RESEARCH.md) for what was verified and what
is BuzzOff's own choice), but nothing is hard-coded to it: rounds, buzzer rules
and scoring are all configuration.

## Run it

```sh
cp .env.example .env && chmod 600 .env
# set POSTGRES_PASSWORD and BUZZOFF_ADMIN_PASSWORD in .env  (openssl rand -hex 24)
docker compose up -d --build
```

Open `http://<server>:3210/host`, sign in with `BUZZOFF_ADMIN_PASSWORD`, and
press **New game → Create game**. A starter pack (14 categories, 12 surveys) is
installed on first boot so there is something to play immediately.

| Setting | Default | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | required | Database password. Letters and digits only; it is embedded in a URL. |
| `BUZZOFF_ADMIN_PASSWORD` | empty | Password for hosting and editing packs. **Empty means anyone who can reach the server can host and read every answer.** |
| `BUZZOFF_PORT` | `3210` | Port published on the Docker host. |
| `PUBLIC_URL` | empty | Address players type, e.g. `https://buzz.example.com`. Shown in the lobby and in the QR code. Empty uses whatever address the TV was opened with. |
| `TRUST_PROXY` | `1` | Reverse proxies in front of the app: `0` if exposed directly, `1` behind one proxy, `2` behind Cloudflare *and* a local proxy. Rate limits are per client address, so a value that is too low lumps every player together. |
| `ROOM_TTL_HOURS` | `24` | Idle games are deleted after this long (finished games after 6 hours). |
| `MAX_UPLOAD_MB` | `25` | Largest image, audio or video file a question may use. |

**Behind a reverse proxy** (Nginx Proxy Manager, Caddy, Traefik): forward to
port 3210 and enable WebSocket support. BuzzOff uses WebSockets only — it does
not fall back to long-polling, because polling adds jitter to buzz timing — so
the proxy must pass `Upgrade` requests through.

## Play a game

1. **Host** — `/host` on a laptop. Pick a format and a pack, create the game.
   The console opens with the room code.
2. **TV** — open `/tv/CODE` on the screen everyone can see (the console has an
   *Open TV* button) and make it full screen. Click it once: browsers will not
   play sound until someone has interacted with the page.
3. **Players** — go to the address on the TV, enter the code (or scan the QR),
   pick a name and avatar.
4. **Run the show from the keyboard.** The next step is always on the space
   bar: start, begin round, arm buzzers, back to the board. `C` and `X` rule an
   answer correct or incorrect, `R` reveals an answer nobody got, `U` undoes
   the last step, `P` pauses, `?` lists the shortcuts.

Things that go wrong at a party, and what to do:

| Situation | What to do |
|---|---|
| Wrong ruling, wrong clue, fat-fingered anything | **Undo** (`U`). The last 40 host steps can be unwound. |
| A buzz is disputed | **Re-do the buzz** discards it and re-arms for everyone still in. |
| A clue was bad | **Throw out clue** reverses its scoring and puts it back on the board. |
| A score needs correcting | `−` / `+` next to the player, or click the player to type a score. |
| A phone dies or a browser closes | Reopening the page puts them straight back in their seat. |
| Someone switches to a different phone | They join again under the same name; you get a prompt to let them take over the seat. |
| The server restarts mid-game | The game comes back **paused** with scores and seats intact. Resume when ready. |

## On phones

The join screen and the controller are fixed, single-screen layouts: the page
itself never scrolls. Each screen is sized from the part of the display that
is actually visible, so it adapts to browser bars appearing and disappearing,
notches and home indicators, a phone turned on its side, and the on-screen
keyboard (the field you are typing in and its button stay above it). The only
things that scroll are long lists, such as a scoreboard with many players, and
they scroll inside their own area with your row pinned in view.

Adding BuzzOff to the Home Screen (Share → *Add to Home Screen*) opens it as a
full-screen app with no browser bars at all, which gives the buzzer the most
room. On iPhone the buzzer gives a light haptic tick where Safari allows it;
Android phones vibrate.

## Buzz timing: what the numbers mean

After each buzz the screens show a line per player, for example:

```
Matthew   327 ms   first
Daniel    355 ms   +28 ms
Jake      411 ms   +84 ms
```

These are **server-recorded times**: the milliseconds between the server arming
the buzzers and the server receiving each buzz, on the server's monotonic
clock. They are not reaction times. Each one includes the time the "armed"
signal took to reach that phone and the time the buzz took to travel back, so
a player on a slow connection is at a real disadvantage that the number cannot
separate from slow thumbs.

- The winner is the first buzz the server receives. Exact ties (same
  millisecond) go to the one processed first.
- Phones never send a timestamp, so there is nothing for a client to forge.
- Each player's **ping** is shown separately, on their own phone and on the
  host console. It is the round trip measured *by the server*; a client can
  make it look worse by answering slowly but never better.
- For remote games the host can choose **latency-adjusted** arbitration: buzzes
  are collected for a short window (150 ms by default) and ranked after
  subtracting half of each player's measured ping, capped at 150 ms. This
  narrows the gap between good and bad connections. It is an estimate — pings
  fluctuate and are not symmetric — and the screens label adjusted times as
  adjusted. On a shared Wi-Fi network, leave it off.

## Formats and rules

Built-in presets: **The Full Show**, **Classic Trivia**, **Quick Play**,
**Jackpot Finale** and **Survey Night**. Any of them can be customised on the
New game page and saved as your own preset. The options:

- **Rounds** — any sequence of *trivia board*, *final* (everyone wagers on one
  written-answer question) and *Fast Money* (survey questions against the clock).
- **Buzzers** — host-armed or automatic; what an early buzz costs (nothing, a
  lockout, points); whether a wrong answer re-arms for steals; whether the same
  player may buzz again; penalty as a percentage of the clue; timers.
- **Fast Money** — who plays (leader, top two, everybody at once), time per
  turn, duplicate blocking, reveal between turns or side by side at the end,
  and what is at stake: points added to scores (optionally with a target and
  bonus) or a *decider* in which the higher survey total wins the game outright.
- **Teams, late joining, eliminations** at the end of a round.

## Question packs

`/host/packs` is the editor. A pack is a pool of trivia categories and survey
questions with no rules attached, so the same pack works for any format; the
New game page tells you whether the packs you picked have enough content.
Clues can carry an image, audio or video (uploaded or by URL), accepted
alternative answers and private host notes. Packs export to and import from a
single JSON file (`*.buzzoff.json`).

Typed Fast Money answers are matched against the survey after normalising case,
accents, punctuation, filler words and plurals, then allowing a small typo, then
looking for an accepted phrase inside the answer. Inexact matches are flagged
"close" on the host console, and the host can change any match before or after
it is revealed.

## Develop

```sh
npm install
npm run dev          # API on :3210, web app with hot reload on :5173
npm test             # engine unit tests + server integration tests
npm run build && npm run test:e2e   # real browsers: host, TV and three phones
npm run typecheck
```

Without `DATABASE_URL` the server keeps everything in memory, which is what
development and the tests use. `npm run test:e2e` needs Playwright's browser
once: `npx playwright install chromium`.

```
packages/shared   types, validated contracts, and the game engine (pure functions)
apps/server       HTTP API, Socket.IO, rooms, persistence
apps/web          React app: join, phone controller, TV, host console, pack editor
e2e               Playwright tests
docs              research notes and architecture
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit, the
state machine, the security model, and how to add a game mode.

## Third-party material

No code, artwork or audio from any other project or show is included. Sounds
are synthesised in the browser. Fonts (Bricolage Grotesque, Figtree, JetBrains
Mono) are bundled under the SIL Open Font License. Runtime dependencies are
permissively licensed: React, Express, Socket.IO, pg, zod, multer and qrcode
under MIT, wouter under the Unlicense. The survey numbers in the starter pack
are invented for illustration; they are not from a real poll.
