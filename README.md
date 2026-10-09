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

`.env` holds only what the server needs before it can read its own settings:

| Variable | Default | What it does |
|---|---|---|
| `POSTGRES_PASSWORD` | required | Database password. Letters and digits only; it is embedded in a URL. |
| `BUZZOFF_ADMIN_PASSWORD` | empty | The host password a **new** server starts with. Read once; after that the password is changed in Settings. **Empty means the server starts open: anyone who can reach it can host, read every answer and set the password.** |
| `BUZZOFF_PORT` | `3210` | Port published on the Docker host. |
| `TRUST_PROXY` | `1` | Reverse proxies in front of the app: `0` if exposed directly, `1` behind one proxy, `2` behind Cloudflare *and* a local proxy. Rate limits are per client address, so a value that is too low lumps every player together. |

Everything else is under **Settings** in the app (`/host/settings`) and takes
effect the moment it is saved, with no restart:

| Setting | Default | What it does |
|---|---|---|
| Players' address | empty | Address players type, e.g. `https://buzz.example.com`. Shown in the lobby and in the QR code. Empty uses whatever address the TV was opened with. |
| Default format | last played | The format the New game page opens on. |
| Keep idle / finished games | 24 h / 6 h | How long a game nobody is touching stays on the server. |
| Largest file | 25 MB | Largest image, audio or video file a question may use. |
| Let players see the leaderboard | off | Off: only the host sees the standings. On: a Leaderboard link appears on the join screen and anyone who can open the address can see players' names, results and statistics. |
| Host password | from `.env` | Changing it needs the current one and signs every device out. |
| Sign-in lasts | 30 days | How long a device stays signed in as host. |

The same page lists the devices signed in as host and keeps an activity log of
sign-ins, password changes and settings changes.

**Upgrading from a version configured through `.env`:** nothing to do. On the
first start, `BUZZOFF_ADMIN_PASSWORD`, `PUBLIC_URL`, `ROOM_TTL_HOURS` and
`MAX_UPLOAD_MB` are copied into the database; from then on they are ignored and
can be deleted from `.env`. Hosts sign in once more, because sessions changed.

**Lost the host password?** Run
`docker compose exec buzzoff node apps/server/dist/index.js reset-admin-password`,
then `docker compose restart buzzoff`. The password is removed (or goes back to
`BUZZOFF_ADMIN_PASSWORD` if that is set) and every device is signed out.

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
   pick a name and avatar, and tap **I'm ready**. The show can start once
   everyone whose phone is connected has; a phone that has dropped out does
   not hold the room up.
4. **Roll for the first pick.** When the first board begins, every phone shows
   a die. Players tap to roll, the dice land on their phones and on the TV, and
   the highest roll gets the board; tied players roll again on their own. The
   server rolls for anyone who has not tapped after twelve seconds.
5. **Players call the clue, you select it.** Whoever has the board says a
   category and a value out loud ("Movies for 300") and you click it on the
   console. Phones show the board and whose pick it is, but only the host can
   put a clue in play. A correct answer takes the board. Buzzers open the
   moment you select the clue, with a 30-second question timer; **+10 s** and
   **Stop clock** are next to it if you need longer. When someone buzzes in,
   the question disappears from the TV and every phone while you judge the
   answer (you still see it, with the answer). If they are wrong it comes
   back for everyone else, with the timer carrying on where it stopped.
6. **Run the show from the keyboard.** The next step is always on the space
   bar: start, begin round, back to the board. `C` and `X` rule an
   answer correct or incorrect, `R` reveals an answer nobody got, `U` undoes
   the last step, `P` pauses, `?` lists the shortcuts.

Things that go wrong at a party, and what to do:

| Situation | What to do |
|---|---|
| Wrong ruling, wrong clue, fat-fingered anything | **Undo** (`U`). The last 40 host steps can be unwound. |
| The dice roll is taking too long, or you want to skip it | **Space** rolls for everyone who has not. Or click a player and *Give control of the board*. |
| Start is greyed out | Someone has not tapped ready; the console names them. Remove them from the player list if they are not playing after all. |
| A buzz is disputed | **Re-do the buzz** discards it and opens the buzzers again for everyone still in. |
| A clue was bad | **Throw out clue** reverses its scoring and puts it back on the board. |
| A score needs correcting | `−` / `+` next to the player, or click the player to type a score. |
| A phone dies or a browser closes | Reopening the page puts them straight back in their seat. |
| Someone switches to a different phone | They join again under the same name; you get a prompt to let them take over the seat. |
| The server restarts mid-game | The game comes back **paused** with scores and seats intact. Resume when ready. |

## The leaderboard

Every finished game is kept in **History**. The **Leaderboard** page adds
those games up into all-time standings: games played, wins and win rate, total,
average and best score, how many judged answers were right, and how each
player does on the buzzer. Tap a player for their full record and latest
games.

- **Nobody registers.** The first time a phone joins a game the server gives
  it a cookie, and from then on that phone is the same player whatever name or
  avatar is typed. The cookie holds a random key and nothing else; it is not
  readable by scripts and is only ever sent to this server.
- **New phone, cleared browser, private window?** That starts a new entry.
  Open either entry on the host's Leaderboard page and merge them; a merge can
  be undone from the same place. Games from before this feature are matched by
  name, and can be separated the same way if two people shared one.
- **What counts.** Any finished game with two or more players in which
  something was played. Playing alone is practice. A win needs someone to
  beat: when everyone finishes level, nobody is credited with one. Every
  member of a winning team gets the win.
- **How it is ranked.** By wins, with win rate breaking ties, and players who
  are level share a rank. The other orders are win rate, points, accuracy and
  buzzer. Rates only rank players with enough behind them (3 games, 10 judged
  answers, 10 buzzes — or as many as the busiest player has, while the league
  is new); everyone else is listed underneath. Points are shown but formats
  score differently, so they say more about how much someone plays than how
  well.
- **Corrections.** The standings are worked out from History, not stored.
  Remove a game from History and it stops counting; undo the end of a game and
  it never counted.

Only the host sees the leaderboard unless *Let players see the leaderboard* is
switched on in Settings.

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

These are **server-recorded times**: the milliseconds between the server opening
the buzzers and the server receiving each buzz, on the server's monotonic
clock. They are not reaction times. Each one includes the time the "open"
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
- **Buzzers** — they open by themselves when a clue is selected. The rules
  cover the question timer (30 seconds by default) and the answer timer;
  whether a wrong answer opens them again for steals; whether the same player
  may buzz again; and the penalty as a percentage of the clue.
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
permissively licensed: React, Express, Socket.IO, pg, zod, multer, compression and qrcode
under MIT, wouter under the Unlicense. The survey numbers in the starter pack
are invented for illustration; they are not from a real poll.
