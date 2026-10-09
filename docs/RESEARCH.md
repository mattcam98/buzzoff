# Research notes

What was looked at before designing BuzzOff, what it established, and where
BuzzOff made its own choices. Read the confidence notes: none of this comes
from an official rulebook.

## Mogul Money

### How this was researched

There is no written rules summary online; the fan wikis are stubs and press
coverage only says "Jeopardy-style". The findings below come from the
auto-generated captions of nine episodes (Season 2 episodes 1, 2, 4, 5 and 7;
Season 1 episodes 1, 4 and 6; the 2022 live show), reading what the host says
on air. Captions are machine-made, so wording is approximate. Only one episode
(S2E5) was read start to finish; the others were searched by keyword. Treat
"verified" as "heard stated on the show at least once", not as a rule that
held in every episode.

### Stated on the show

| Mechanic | BuzzOff |
|---|---|
| Three contestants; Board 1, Board 2, "Final Trivia", then the top two play Fast Money. | *The Full Show* preset has exactly these four rounds. Player count is not limited to three. |
| Boards are 5 categories × 5 clues, harder as the value rises. Board 1 is 100–500, Board 2 is double. Scores are points. | Same defaults; board size and multiplier are configurable per round. |
| A wrong answer deducts the clue value; scores go negative. No penalty for staying quiet. | Default. The penalty is a configurable percentage. |
| After a wrong answer the buzzers reopen for a steal, and the same player may buzz again. | `reopenOnIncorrect` and `rebuzz`. Every built-in format reopens for a steal. *The Full Show* also lets the player who missed buzz again, as on the show; the other formats keep them locked out of that clue unless "Second chances" is turned on in the rules. |
| Either/or categories ("Higher or Lower") allow no steals. | A category can be marked *single attempt*. |
| A correct answer takes the board; after a miss or silence the previous picker keeps it. Last place picks first on Board 2. | Implemented as described. As on the show, the contestant calls the clue out loud and the host puts it up: phones show the board but cannot select from it. |
| One hidden wager clue per board; only the finder answers; the wager is set before the clue is shown; "up to all your points, or 1,000 if you have less". | Implemented; the count per board and the 1,000 floor are configurable. |
| Final Trivia: all play, the category is shown first, wagers are entered on phones, about a minute to write an answer, reveals one at a time. | The `final` mode. Trailing players are revealed first. |
| Fast Money is head to head: board scores only seed it, the leader goes first with the opponent out of the room, five survey questions, a duplicate answer gets a buzzer and must be replaced, the higher total wins. No target score. | *The Full Show* uses `stakes: decider` with duplicate blocking and no target. |
| Survey answers come from 100 audience members. | Packs store survey answers with points; the editor shows the running total. |

### Not confirmed, and what BuzzOff does instead

These are BuzzOff's assumptions. All are settings, not fixed behaviour.

- **Buzzing in.** Buzzers open the moment the host puts a clue up; there is no
  separate arming step and so no such thing as buzzing too early. Players may
  buzz while the host is still reading, as on the show.
- **The question while someone answers.** Once a player has buzzed in, the
  question leaves the TV and every phone until the host has ruled, so nobody
  keeps reading while another player is on the spot. A wrong answer brings it
  back for the players still in. A wager clue is answered alone, so its
  question stays up.
- **Timers.** The show's answer time is an informal host countdown. BuzzOff
  shows a clock (a 30 s question timer, then 30 s to answer, by default). The
  question timer stands still while an answer is judged and carries on from
  where it stopped if the buzzers reopen, never with less than five seconds
  so that a steal is possible. The host can add ten seconds or stop the clock
  at any point. The answer clock
  never rules on its own: when it runs out the room hears it and the host
  still decides. Either timer can be turned off.
- **Fast Money clock.** The show gives 30 and 35 seconds for spoken answers.
  Typing on a phone is slower, so BuzzOff defaults to 45 seconds plus 10 for
  each later turn. The host can also type answers for a contestant who says
  them out loud.
- **Fast Money reveal.** How the show sequences the reveal was not established
  beyond "per question". BuzzOff's decider reveals side by side, question by
  question, after both have played, which also works when the second
  contestant cannot leave the room. The classic "reveal the first contestant,
  then cover the board" order is available as `reveal: afterEachTurn`.
- **First pick on Board 1.** Decided differently each episode. BuzzOff has
  everyone roll a die on their phone: the highest roll takes the board and
  ties roll again. The host can skip it by handing the board to anyone.
- **Wagers when a player has nothing.** The show improvised the cap for Final
  Trivia. BuzzOff applies the same "your score, or the floor if you have less"
  rule as for hidden wagers.
- **Ties.** No general rule was stated. In a decider BuzzOff breaks a tie on
  survey points with the board score, and declares joint winners if that is
  level too.
- **Whether contestants buzz with phones** on the show is unknown. The buzzer
  hardware or software used was not identified.

### Left out on purpose

- **The phone-a-friend lifeline.** It is a production device rather than a
  game mechanic; the host can pause the game or add time to a clock to stage
  one.
- **"Answer in the form of a question".** That is the host's call when ruling.
- **Sponsor-named segments, the show's name, artwork, music and catchphrases.**
  BuzzOff has its own identity and uses generic names (*wager*, *final*).

## Open-source buzzer projects

Four projects were reviewed for ideas. Their READMEs and main state and buzzer
files were read through a summarising fetch rather than line by line, so the
specifics here are impressions to learn from, not audited facts.

| Project | Licence | Shape |
|---|---|---|
| bhaveshraheja/jeopardybuzzer | none found | Node, raw WebSockets, vanilla JS; host, board, phones and editor on one socket |
| michael-moscatt/quiz-showdown | none found | React and Socket.IO; every player on their own screen, typed answers judged by similarity |
| the-snesler/buckys-buzzer-beater | none found | Rust server, React client; room code plus host token; host, projection and player pages |
| stuartthomas25/JParty | GPL-3.0 | Python desktop app that is host console and TV, with a small web server for phone buzzers |

**None of their code is used.** Three have no licence, which means no
permission to reuse; the fourth is copyleft. What BuzzOff took was the shape
of the problem:

- All four order buzzes by arrival at the server and none trusts a client
  timestamp. BuzzOff does the same and additionally records the receive time
  so the gap between players can be shown.
- An explicit state machine with the server deriving "may this player buzz"
  works; scattered boolean flags do not. BuzzOff's engine is a state machine
  per mode and sends each phone its own computed buzzer state.
- Full snapshots redacted per role are simpler and safer than dozens of
  granular events. BuzzOff sends a public view, a host view and a private
  per-player view after every change.
- A device-held token validated on every connection gives painless rejoin.
- Recurring weaknesses to avoid: roles declared by the client and never
  checked, payloads used unvalidated, identity lost on reload, no reconnect
  path, room codes without collision checks, and lockouts enforced only in the
  browser.

One of them uses its latency estimate to make the "buzzers open" signal reach
every phone at the same moment rather than to re-rank buzzes. BuzzOff's
optional latency-adjusted mode takes the re-ranking approach instead, with a
cap and a collection window; the README is explicit that it is an estimate.
