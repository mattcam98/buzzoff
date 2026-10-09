/** The in-round scenes of the shared screen, one per game mode. */
import type { FastMoneyPublic, FinalPublic, Media, TriviaPublic } from '@buzzoff/shared';
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { fmtDelta, fmtScore } from '../../lib/format';
import { answerScale, BuzzLadder, Die, MediaView, rollLeaders, Seconds, textScale } from '../../ui/game';
import { Avatar, cx, TimerBar } from '../../ui/kit';
import type { SceneProps } from '../Tv';

// ---------------------------------------------------------------- room for everyone
//
// A screen has to hold three players or fifty. These say how a list is arranged for the number in
// it, as custom properties; the stylesheet then sizes its rows or tiles to the space there is.

/** A row for every `across` tiles, but `most` rows at most: past that the rows get longer instead. */
export const rowsOf = (count: number, across: number, most: number) => Math.min(most, Math.max(1, Math.ceil(count / across)));

/** Tiles in so many rows. */
export const inRows = (count: number, rows: number) => ({ '--rows': rows, '--per-row': Math.max(1, Math.ceil(count / rows)) }) as CSSProperties;

/** A ranked list: down one column while it is short enough to read at full size (`fit` rows), then across up to four. */
export function columnsFor(count: number, fit: number): CSSProperties {
  const columns = rowsOf(count, fit, 4);
  return { '--columns': columns, '--rows': Math.ceil(count / columns) } as CSSProperties;
}

// ---------------------------------------------------------------- room for every word
//
// Text is as long as whoever wrote the pack made it, the room it gets depends on what else is on the
// screen, and a TV cannot scroll. Neither is known before it is laid out, so the box is measured.

/** Whether what is in a box is taller than the box. Going by layout alone, so that something still being scaled or slid into place by its entrance animation is measured where it will end up. */
function overflows(box: HTMLElement) {
  const inside = [...box.children] as HTMLElement[];
  if (!inside.length) return false;
  const style = getComputedStyle(box);
  const room = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const top = Math.min(...inside.map((el) => el.offsetTop));
  const bottom = Math.max(...inside.map((el) => el.offsetTop + el.offsetHeight));
  return bottom - top > room + 1;
}

/** Full size if that fits; otherwise `--fit` comes down a step at a time until it does. The stylesheet sizes the type by it. */
function fit(box: HTMLElement, tiles?: string) {
  const full = () => (tiles ? [...box.querySelectorAll<HTMLElement>(tiles)] : [box]).some(overflows);
  box.style.removeProperty('--fit');
  for (let percent = 96; percent >= 40 && full(); percent -= 4) box.style.setProperty('--fit', String(percent / 100));
}

/** A ref for a box whose contents must fit it. Given `tiles`, a selector, it is each of those inside the box that must hold its own. */
export function useFit<T extends HTMLElement>(tiles?: string) {
  const [box, setBox] = useState<T | null>(null);
  // Any render may have changed what is in the box.
  useLayoutEffect(() => {
    if (box) fit(box, tiles);
  });
  // The box changes size with the screen and with what is around it, and text changes size when its font arrives.
  useEffect(() => {
    if (!box) return;
    const again = () => fit(box, tiles);
    const resized = new ResizeObserver(again);
    resized.observe(box);
    document.fonts.addEventListener('loadingdone', again);
    return () => {
      resized.disconnect();
      document.fonts.removeEventListener('loadingdone', again);
    };
  }, [box, tiles]);
  return setBox;
}

/** The card a question is read from, with its picture or sound. `instead` is shown while there is no question to read. */
function QuestionCard({ question, media, instead }: { question: string | null; media: Media | null; instead?: ReactNode }) {
  const card = useFit<HTMLDivElement>();
  return (
    <div ref={card} className="tv-clue__body" data-media={media?.kind} data-hidden={question === null || undefined}>
      {media && <MediaView media={media} className="tv-clue__media" />}
      {question === null ? (
        instead
      ) : (
        <p className="tv-clue__q" data-scale={textScale(question)}>
          {question}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- trivia

export function TriviaScene({ pub, snap, players, round }: SceneProps & { round: TriviaPublic }) {
  const clue = round.clue;
  if (round.stage === 'roll' && round.roll) return <RollScene pub={pub} snap={snap} players={players} roll={round.roll} />;
  if (!clue) return <Board round={round} players={players} />;

  const answerer = clue.answererId ? players[clue.answererId] : null;
  const wagerer = clue.wager ? players[clue.wager.playerId] : null;
  const winner = clue.stage === 'result' ? clue.judgments.find((j) => j.correct) : null;

  if (clue.stage === 'wager' && wagerer) {
    return (
      <div className="tv-wager">
        <span className="tv-wager__burst">Wager!</span>
        <Avatar avatar={wagerer.avatar} size="7em" />
        <h2>{wagerer.name}</h2>
        <p>
          is deciding how much to risk on <strong>{clue.category}</strong>
        </p>
        <span className="bz-eyebrow">Up to {fmtScore(clue.wager!.max)} points</span>
      </div>
    );
  }

  return (
    <div className="tv-clue" data-stage={clue.stage}>
      <header className="tv-clue__head">
        <span className="tv-clue__cat">{clue.category}</span>
        <span className="tv-clue__value bz-num">{clue.isWager ? `Wager ${fmtScore(clue.wager?.amount ?? 0)}` : fmtScore(clue.value)}</span>
      </header>

      <QuestionCard
        question={clue.question}
        media={clue.media}
        // Nobody reads on while an answer is judged; the question comes back if the buzzers reopen.
        instead={<p className="tv-clue__hidden">Question hidden while {answerer?.name ?? 'the answer'} {answerer ? 'answers' : 'is judged'}</p>}
      />

      <TimerBar timer={clue.timer} held={clue.held} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} className="tv-clue__timer" />

      <div className="tv-clue__status" key={`${clue.stage}-${clue.answererId}-${clue.judgments.length}`}>
        {clue.stage === 'reading' && (
          <div className="tv-status tv-status--locked">
            <span aria-hidden>🔒</span> Buzzers locked
          </div>
        )}
        {clue.stage === 'open' && (
          <div className="tv-status tv-status--open">
            {clue.collecting ? 'Buzz received…' : clue.judgments.length ? 'Steal it! Buzz!' : 'Buzz!'}
            <Seconds pub={pub} snap={snap} className="tv-status__count" />
          </div>
        )}
        {clue.stage === 'answering' && answerer && (
          <div className="tv-answering">
            <div className="tv-answering__who">
              <Avatar avatar={answerer.avatar} size="4.6em" />
              <div>
                <span className="bz-eyebrow">{clue.isWager ? 'Answering for the wager' : 'First on the buzzer'}</span>
                <h2>{answerer.name}</h2>
              </div>
              {clue.answerTimeUp ? <span className="tv-answering__time">Time!</span> : <Seconds pub={pub} snap={snap} className="tv-answering__count" />}
            </div>
            <div className="tv-ladder">
              <BuzzLadder attempts={clue.attempts} players={players} adjusted={pub.buzzer.arbitration === 'latencyAdjusted'} limit={4} />
              <small>{pub.buzzer.arbitration === 'latencyAdjusted' ? 'Server times, adjusted for each player’s ping' : 'Times recorded by the server'}</small>
            </div>
          </div>
        )}
        {clue.stage === 'result' && (
          <div className="tv-result">
            <div className="tv-result__answer">
              <span className="bz-eyebrow">{clue.timedOut ? 'Time’s up! The answer was' : 'Answer'}</span>
              <strong data-scale={answerScale(clue.answer ?? '')}>{clue.answer}</strong>
            </div>
            <ul className="tv-result__rulings">
              {clue.judgments.map((j, i) => {
                const p = players[j.playerId];
                return p ? (
                  <li key={i} data-correct={j.correct}>
                    <Avatar avatar={p.avatar} size="1.8em" />
                    {p.name}
                    <b className="bz-num">{fmtDelta(j.delta)}</b>
                  </li>
                ) : null;
              })}
              {!winner && clue.judgments.length === 0 && <li data-nobody>Nobody got this one</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** The roll for the first pick: every player's die, side by side. */
function RollScene({ pub, players, roll }: SceneProps & { roll: NonNullable<TriviaPublic['roll']> }) {
  const tied = roll.phase === 'tied' ? rollLeaders(roll) : [];
  const names = (ids: string[]) => ids.map((id) => players[id]?.name).filter(Boolean).join(' & ');
  const winner = roll.winnerId ? players[roll.winnerId] : null;
  const title = winner ? `${winner.name} picks first!` : tied.length ? 'It’s a tie!' : roll.round === 1 ? 'Roll for the first pick' : `Tie-break: ${names(roll.contenders)}`;
  const shown = pub.players.filter((p) => roll.contenders.includes(p.id) || roll.out[p.id] !== undefined);

  return (
    <div className="tv-roll" data-phase={roll.phase}>
      <header className="tv-roll__head">
        <span className="bz-eyebrow">{roll.round === 1 ? 'Who picks first?' : `Tie-break ${roll.round - 1}`}</span>
        <h2 key={title} className="bz-pop">
          {title}
        </h2>
        <p>
          {winner ? 'Call your category and points.' : tied.length ? `${names(tied)} roll again.` : 'Tap your phone to roll. Highest roll wins.'}
        </p>
      </header>
      {/* One row of dice for up to eleven players, two for up to thirty-two (two long rows make for bigger dice than three short ones), then three. */}
      <ul
        className="tv-roll__players"
        data-count={shown.length > 8 ? 'many' : shown.length > 4 ? 'some' : 'few'}
        style={inRows(shown.length, shown.length <= 11 ? 1 : shown.length <= 32 ? 2 : 3)}
      >
        {shown.map((p) => {
          const inIt = roll.contenders.includes(p.id);
          return (
            <li key={p.id} data-out={!inIt || (tied.length > 0 && !tied.includes(p.id)) || undefined} data-winner={p.id === roll.winnerId || undefined}>
              <Avatar avatar={p.avatar} size="3.4em" dim={!inIt} />
              <strong>{p.name}</strong>
              <Die value={roll.rolls[p.id] ?? roll.out[p.id] ?? null} className="tv-roll__die" />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Board({ round, players }: { round: TriviaPublic; players: SceneProps['players'] }) {
  const picker = round.controlId ? players[round.controlId] : null;
  const rows = Math.max(...round.board.map((c) => c.clues.length));
  // The widest value on the board, in characters: every tile sets its number small enough for that one.
  const digits = Math.max(...round.board.flatMap((c) => c.clues.map((cl) => fmtScore(cl.value).length)));
  // And the longest word in any title: every heading is set small enough for that one to stay in one piece.
  const letters = Math.max(...round.board.flatMap((c) => c.title.split(/\s+/).map((word) => word.length)));
  const grid = { '--digits': digits, '--letters': letters, gridTemplateColumns: `repeat(${round.board.length}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${rows}, minmax(0, 1fr))` } as CSSProperties;
  return (
    <div className="tv-board-wrap">
      <div className="tv-board" style={grid}>
        {round.board.map((cat, c) => (
          <div key={`h${c}`} className="tv-board__cat" style={{ gridColumn: c + 1, animationDelay: `${c * 70}ms` }}>
            <span>{cat.title}</span>
          </div>
        ))}
        {round.board.flatMap((cat, c) =>
          cat.clues.map((cl, k) => (
            <div key={`${c}-${k}`} className="tv-board__cell" data-used={cl.used || undefined} style={{ gridColumn: c + 1, gridRow: k + 2, animationDelay: `${200 + (c + k) * 45}ms` }}>
              {/* A played clue keeps its value, dimmed, with whoever won it in the corner. */}
              <span className="bz-num">{fmtScore(cl.value)}</span>
              {cl.used && cl.winnerId && players[cl.winnerId] && <Avatar avatar={players[cl.winnerId].avatar} size="1em" className="tv-board__won" />}
            </div>
          )),
        )}
      </div>
      {picker && (
        <p className="tv-board__picker">
          <Avatar avatar={picker.avatar} size="1.6em" /> <strong>{picker.name}</strong> has the board
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fast money

export function FastMoneyScene({ pub, snap, players, round }: SceneProps & { round: FastMoneyPublic }) {
  const contestants = round.turns.flat();
  const crowd = round.participants === 'all';
  const active = round.turns[round.turn] ?? [];
  const winners = round.outcome?.winners ?? [];
  const focusQ = round.focus?.q ?? (round.stage === 'result' ? null : 0);
  // Once it is over, each question has the survey's top answer on a line of its own underneath.
  const topAnswer = (q: number) => (round.stage === 'result' || round.stage === 'done' ? round.topAnswers[q] : null);
  // The questions share the height of the board between them; a line for a top answer takes only what it needs.
  const rows = ['auto', ...round.questions.map((_, q) => (topAnswer(q) ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)'))].join(' ');
  const board = useFit<HTMLDivElement>('.tv-fm__q, .tv-fm__cell');
  // An answer too long for one line of its tile is set in two smaller ones.
  const long = contestants.length > 1 ? 20 : 32;

  const banner =
    round.stage === 'ready' ? (crowd ? 'Phones at the ready…' : `${players[active[0]]?.name ?? 'Next contestant'}, you’re up`) :
    round.stage === 'answering' ? (crowd ? 'Answer on your phone!' : `${players[active[0]]?.name ?? ''} is answering`) :
    round.stage === 'reveal' ? 'Survey says…' :
    round.outcome && round.stakes === 'decider' ? `${winners.map((id) => players[id]?.name).filter(Boolean).join(' & ')} ${winners.length > 1 ? 'tie it' : 'wins it'}!` :
    round.outcome?.targetHit ? 'Jackpot!' : round.outcome?.targetHit === false ? 'So close…' : 'Final totals';

  return (
    <div className="tv-fm" data-stage={round.stage}>
      <header className="tv-fm__head">
        <h2 key={banner} className="bz-pop">{banner}</h2>
        {round.timer && (
          <div className="tv-fm__clock">
            <Seconds pub={pub} snap={snap} className="tv-fm__seconds" />
            <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />
          </div>
        )}
        {round.target > 0 && round.stage !== 'answering' && (
          <span className="tv-fm__target">
            Target <b className="bz-num">{round.target}</b>
          </span>
        )}
      </header>

      {crowd ? (
        <CrowdBoard round={round} players={players} focusQ={focusQ} />
      ) : (
        <div ref={board} className="tv-fm__board" style={{ gridTemplateColumns: `minmax(0, 1.5fr) repeat(${contestants.length}, minmax(0, 1fr))`, gridTemplateRows: rows }}>
          <div className="tv-fm__corner" />
          {contestants.map((id) => {
            const p = players[id];
            return (
              <div key={id} className="tv-fm__player" data-active={(active.includes(id) && round.stage !== 'result' && round.stage !== 'reveal') || undefined} data-winner={winners.includes(id) || undefined}>
                {p && <Avatar avatar={p.avatar} size="2.2em" />}
                <strong>{p?.name ?? 'Left the game'}</strong>
                <span className="bz-num">{round.totals[id] ?? 0}</span>
              </div>
            );
          })}
          {round.questions.map((q, i) => (
            <div key={i} className="tv-fm__row" data-focus={round.focus?.q === i || undefined}>
              <div className="tv-fm__q">
                <span className="bz-num">{i + 1}</span>
                {round.stage === 'ready' && round.turn === 0 ? <i>Question {i + 1}</i> : <span>{q}</span>}
              </div>
              {round.turns.map((group, turn) =>
                group.map((id) => {
                  const cell = round.cells[id]?.[i];
                  const hidden = round.covered && turn < round.turn;
                  const focused = round.focus?.q === i && round.focus.turn === turn;
                  return (
                    <div key={id} className="tv-fm__cell" data-focus={focused || undefined} data-zero={cell?.points === 0 || undefined}>
                      {hidden ? (
                        <span className="tv-fm__covered">Hidden</span>
                      ) : (
                        <>
                          <span className="tv-fm__answer" key={cell?.text ?? 'x'} data-long={(cell?.text?.length ?? 0) > long || undefined}>{cell?.text === null ? '' : cell?.text || '–'}</span>
                          <b className="bz-num" key={`p${cell?.points}`}>{cell?.points ?? ''}</b>
                        </>
                      )}
                    </div>
                  );
                }),
              )}
              {topAnswer(i) && (
                <div className="tv-fm__top" style={{ gridColumn: `1 / -1` }}>
                  Top answer: <strong>{topAnswer(i)!.text}</strong> <b className="bz-num">{topAnswer(i)!.points}</b>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {round.stage === 'answering' && !crowd && (
        <p className="tv-fm__progress">
          {active.map((id) => `${round.progress[id]?.answered ?? 0} of ${round.questions.length} answered`).join(' · ')}
          {round.blockDuplicates && round.turn > 0 && ' · no repeats allowed'}
        </p>
      )}
      {round.outcome && round.target > 0 && (
        <p className="tv-fm__progress">
          {round.participants === 'all' ? 'Target' : 'Combined'}: <b className="bz-num">{round.outcome.combined}</b> / {round.target}
          {round.outcome.targetHit && <> · bonus {fmtDelta(round.outcome.bonus)}</>}
        </p>
      )}
    </div>
  );
}

/** Everybody-plays layout: one question at a time, with every player's answer underneath. */
function CrowdBoard({ round, players, focusQ }: { round: FastMoneyPublic; players: SceneProps['players']; focusQ: number | null }) {
  const ids = round.turns.flat();
  // Everyone in the room has a tile on these lists, brought down in size until the last of them is on the screen.
  const tiles = useFit<HTMLUListElement>();
  if (round.stage === 'ready' || round.stage === 'answering') {
    return (
      <ul ref={tiles} className="tv-crowd__progress">
        {ids.map((id) => {
          const p = players[id];
          const prog = round.progress[id];
          return p ? (
            <li key={id} data-done={prog?.finished || undefined}>
              <Avatar avatar={p.avatar} size="3em" />
              <strong>{p.name}</strong>
              <span className="bz-mono">{prog?.finished ? 'Locked in' : `${prog?.answered ?? 0}/${round.questions.length}`}</span>
            </li>
          ) : null;
        })}
      </ul>
    );
  }
  if (focusQ === null) {
    const ranked = [...ids].sort((a, b) => (round.totals[b] ?? 0) - (round.totals[a] ?? 0));
    return (
      <ol className="tv-crowd__totals" style={columnsFor(ranked.length, 6)}>
        {ranked.map((id) => {
          const p = players[id];
          return p ? (
            <li key={id} data-winner={round.outcome?.winners.includes(id) || undefined}>
              <Avatar avatar={p.avatar} size="2.4em" />
              <strong>{p.name}</strong>
              <b className="bz-num">{round.totals[id] ?? 0}</b>
            </li>
          ) : null;
        })}
      </ol>
    );
  }
  return (
    <div className="tv-crowd" key={focusQ}>
      <p className="tv-crowd__q">
        <span className="bz-num">{focusQ + 1}</span>
        {round.questions[focusQ]}
      </p>
      <ul ref={tiles} className="tv-crowd__answers">
        {ids.map((id, i) => {
          const p = players[id];
          const cell = round.cells[id]?.[focusQ];
          if (!p || !cell || cell.text === null) return null;
          return (
            <li key={id} data-zero={cell.points === 0 || undefined} style={{ animationDelay: `${i * 60}ms` }}>
              <Avatar avatar={p.avatar} size="1.7em" />
              <span>
                <small>{p.name}</small>
                {cell.text || '–'}
              </span>
              {cell.points !== null && <b className="bz-num">{cell.points}</b>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- final

export function FinalScene({ pub, snap, players, round }: SceneProps & { round: FinalPublic }) {
  const current = round.reveals.at(-1);
  const currentPlayer = current ? players[current.playerId] : null;
  const waitingOn = round.stage === 'wager' ? round.wagered : round.answered;
  const judged = round.reveals.filter((r) => r.correct !== null && (round.answer || r !== current));

  return (
    <div className="tv-final" data-stage={round.stage}>
      <header className="tv-clue__head">
        <span className="tv-clue__cat">{round.category}</span>
        <span className="tv-clue__value bz-num">{round.title}</span>
      </header>

      {round.stage === 'wager' ? (
        <div className="tv-final__prompt">
          <h2>Place your wagers</h2>
          <p>You know the category. How confident are you?</p>
        </div>
      ) : (
        <QuestionCard question={round.question ?? ''} media={round.media} />
      )}

      <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} className="tv-clue__timer" />

      {(round.stage === 'wager' || round.stage === 'answering') && (
        <div className="tv-final__waiting">
          <Seconds pub={pub} snap={snap} className="tv-status__count" />
          {/* Five names to a row, on four rows at most. */}
          <ul style={inRows(round.players.length, rowsOf(round.players.length, 5, 4))}>
            {round.players.map((id) => {
              const p = players[id];
              return p ? (
                <li key={id} data-done={waitingOn.includes(id) || undefined}>
                  <Avatar avatar={p.avatar} size="2.8em" />
                  <strong>{p.name}</strong>
                  <span>{waitingOn.includes(id) ? '✓ Locked in' : round.stage === 'wager' ? 'Wagering…' : 'Writing…'}</span>
                </li>
              ) : null;
            })}
          </ul>
        </div>
      )}

      {round.stage === 'reveal' && (
        <div className="tv-final__reveal">
          {round.answer ? (
            <div className="tv-result__answer bz-pop">
              <span className="bz-eyebrow">Correct answer</span>
              <strong data-scale={answerScale(round.answer)}>{round.answer}</strong>
            </div>
          ) : current && currentPlayer ? (
            <div className="tv-final__card" key={current.playerId} data-correct={current.correct ?? undefined}>
              <Avatar avatar={currentPlayer.avatar} size="4.4em" />
              <div>
                <span className="bz-eyebrow">{currentPlayer.name} wrote</span>
                <strong data-scale={answerScale(current.answer ?? '')}>{current.answer || 'Nothing at all'}</strong>
              </div>
              {current.correct !== null && (
                <div className="tv-final__verdict">
                  <span>{current.correct ? 'Correct' : 'Wrong'}</span>
                  <b className="bz-num">{fmtDelta(current.delta ?? 0)}</b>
                </div>
              )}
            </div>
          ) : (
            <p className="tv-final__ready">Pens down. Let’s see what you wrote.</p>
          )}
          <ul className="tv-final__done">
            {/* The latest fifteen verdicts stay up. In a bigger room the earliest make way: their scores are on the podiums below. */}
            {judged.length > 15 && <li data-more>+{judged.length - 15} earlier</li>}
            {judged.slice(-15).map((r) => {
              const p = players[r.playerId];
              return p ? (
                <li key={r.playerId} data-correct={r.correct}>
                  <Avatar avatar={p.avatar} size="1.6em" /> {p.name} <b className="bz-num">{fmtDelta(r.delta ?? 0)}</b>
                </li>
              ) : null;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
