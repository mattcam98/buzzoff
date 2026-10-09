/** The host's controls for each game mode. The next step is always the big button on Space. */
import type { FastMoneyPublic, FastMoneySecret, FinalPublic, FinalSecret, TriviaPublic, TriviaSecret } from '@buzzoff/shared';
import { useState, type FormEvent } from 'react';
import { fmtDelta, fmtScore, plural } from '../../../lib/format';
import { BuzzLadder, Die, rollLeaders, Seconds } from '../../../ui/game';
import { Avatar, Button, cx, TimerBar } from '../../../ui/kit';
import type { StageProps } from '../HostConsole';
import { usePeek } from './peek';

function TimerTools({ pub, snap, run, running }: Pick<StageProps, 'pub' | 'snap' | 'run'> & { running: boolean }) {
  if (!running) return null;
  return (
    <div className="hc-timer">
      <Seconds pub={pub} snap={snap} className="hc-timer__count" />
      <Button size="s" variant="ghost" onClick={() => run({ t: 'timer.extend', sec: 10 })}>
        +10 s
      </Button>
      <Button size="s" variant="ghost" onClick={() => run({ t: 'timer.stop' })}>
        Stop clock
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- trivia

/** The clue grid. Holding a category title pops its description out over the grid for as long as it is held. */
function Board({ round, secret, players, paused, run }: Pick<StageProps, 'players' | 'run'> & { round: TriviaPublic; secret: TriviaSecret; paused: boolean }) {
  const { peek, holdable } = usePeek();
  const peeked = peek === null ? null : round.board[peek];
  return (
    <div className="hc-board" style={{ gridTemplateColumns: `repeat(${round.board.length}, minmax(0, 1fr))` }}>
      {round.board.map((cat, c) => (
        <div key={c} className="hc-board__col">
          {cat.blurb ? (
            <h3 {...holdable(c)} aria-description={cat.blurb}>
              {cat.title}
            </h3>
          ) : (
            <h3>{cat.title}</h3>
          )}
          {cat.clues.map((cl, k) => {
            const hidden = secret.board[c]?.[k];
            return (
              <button
                key={k}
                disabled={cl.used || paused}
                data-used={cl.used || undefined}
                data-wager={hidden?.wager || undefined}
                onClick={() => run({ t: 'clue.select', cat: c, idx: k })}
                aria-label={`${cat.title} for ${cl.value}${cl.used ? ', already played' : ''}`}
                title={hidden ? `${hidden.question}\n→ ${hidden.answer}` : undefined}
              >
                {fmtScore(cl.value)}
                {cl.used && cl.winnerId && players[cl.winnerId] && <Avatar avatar={players[cl.winnerId].avatar} size={18} className="hc-board__won" />}
                {hidden?.wager && !cl.used && <i aria-label="Hidden wager">★</i>}
              </button>
            );
          })}
        </div>
      ))}
      {peeked?.blurb && (
        <div className="hc-board__blurb" aria-hidden>
          <strong>{peeked.title}</strong>
          {peeked.blurb}
        </div>
      )}
    </div>
  );
}

export function TriviaStage(props: StageProps & { round: TriviaPublic; secret: TriviaSecret }) {
  const { pub, snap, players, run, round, secret } = props;
  const clue = round.clue;
  const [wager, setWager] = useState('');

  if (round.stage === 'roll' && round.roll) return <RollStage {...props} roll={round.roll} />;

  if (!clue) {
    const left = round.board.reduce((n, c) => n + c.clues.filter((cl) => !cl.used).length, 0);
    const picker = round.controlId ? players[round.controlId] : null;
    return (
      <section className="hc-card hc-stage">
        <div className="hc-stage__head">
          <div>
            <span className="bz-eyebrow">{round.title} · {plural(left, 'clue')} left</span>
            <h1>{picker ? `${picker.name} picks` : 'Pick a clue'}</h1>
          </div>
          <Button variant="ghost" size="s" onClick={() => confirm(left ? `End this round with ${plural(left, 'clue')} unplayed?` : 'End this round?') && run({ t: 'round.end' })}>
            End round
          </Button>
        </div>
        <Board round={round} secret={secret} players={players} paused={pub.paused} run={run} />
        <p className="hc-note">
          {picker ? `${picker.name} calls a category and a value; you click it. ` : 'Players call the clue; you click it. '}★ marks a hidden wager (only you
          can see it). Hover a clue to preview it.{round.board.some((cat) => cat.blurb) && ' Hold a category to read its description.'}
        </p>
      </section>
    );
  }

  const answerer = clue.answererId ? players[clue.answererId] : null;
  const wagerer = clue.wager ? players[clue.wager.playerId] : null;
  const stageLabel = { wager: 'Taking a wager', reading: 'Paused', open: 'Buzzers are open', answering: 'Waiting for your ruling', result: 'Answer revealed' }[clue.stage];
  // What the headline leaves out, in small print beneath it so that it never has to share a line with the clock.
  const stageNote = clue.stage === 'reading' ? 'Buzzers open again when you resume' : clue.stage === 'answering' && clue.held ? 'Question hidden, its timer paused' : null;
  const submitWager = (e: FormEvent) => {
    e.preventDefault();
    const amount = Number(wager);
    if (Number.isInteger(amount)) void run({ t: 'wager.set', amount }).then((ok) => ok && setWager(''));
  };

  return (
    <section className="hc-card hc-stage hc-clue" data-stage={clue.stage}>
      <div className="hc-stage__head">
        <div>
          <span className="bz-eyebrow">
            {clue.category} · {clue.isWager ? `wager${clue.wager?.amount != null ? ` ${fmtScore(clue.wager.amount)}` : ''}` : fmtScore(clue.value)}
            {clue.singleAttempt && ' · one attempt, no steals'}
          </span>
          <p className="hc-clue__state">
            {stageLabel}
            {stageNote && <small>{stageNote}</small>}
          </p>
        </div>
        <TimerTools pub={pub} snap={snap} run={run} running={!!clue.timer} />
      </div>
      <TimerBar timer={clue.timer} held={clue.held} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />

      <p className="hc-clue__q">{secret.clue?.question}</p>
      <div className="hc-clue__answer">
        <span className="bz-eyebrow">Answer</span>
        <strong>{secret.clue?.answer}</strong>
        {!!secret.clue?.accept.length && <span>Also accept: {secret.clue.accept.join(' · ')}</span>}
        {secret.clue?.notes && <em>{secret.clue.notes}</em>}
      </div>

      {clue.stage === 'wager' && (
        <form className="hc-wager" onSubmit={submitWager}>
          <p>
            <strong>{wagerer?.name}</strong> is entering a wager on their phone (up to {fmtScore(clue.wager?.max ?? 0)}). The clue stays hidden until it’s locked in. You can also enter it for them:
          </p>
          <input className="bz-input" type="number" min={0} max={clue.wager?.max} step={1} value={wager} onChange={(e) => setWager(e.target.value)} placeholder="Wager" aria-label="Wager amount" />
          <Button type="submit" variant="primary" disabled={wager === ''}>
            Lock wager
          </Button>
        </form>
      )}

      {clue.stage === 'answering' && answerer && (
        <div className="hc-answering">
          <Avatar avatar={answerer.avatar} size={52} />
          <div>
            <span className="bz-eyebrow">{clue.isWager ? 'Answering for the wager' : 'First on the buzzer'}</span>
            <strong>{answerer.name}</strong>
          </div>
          {clue.answerTimeUp && <span className="bz-pill bz-pill--bad">Time is up</span>}
        </div>
      )}

      <div className="hc-actions">
        {clue.stage === 'answering' && (
          <>
            <Button variant="good" size="l" hotkey="C" disabled={pub.paused} onClick={() => run({ t: 'judge', correct: true })}>
              Correct
            </Button>
            <Button variant="bad" size="l" hotkey="X" disabled={pub.paused} onClick={() => run({ t: 'judge', correct: false })}>
              Incorrect
            </Button>
            {!clue.isWager && (
              <Button variant="ghost" onClick={() => run({ t: 'buzz.reset' })} title="Throw this buzz out and open the buzzers again for everyone still in">
                Redo the buzz
              </Button>
            )}
          </>
        )}
        {clue.stage === 'result' && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'clue.continue' })}>
            Back to the board
          </Button>
        )}
        {clue.stage !== 'result' && clue.stage !== 'wager' && (
          <Button variant="ghost" hotkey="R" disabled={pub.paused} onClick={() => run({ t: 'clue.reveal' })}>
            Reveal answer
          </Button>
        )}
        <Button variant="ghost" onClick={() => confirm('Throw this clue out? Any points are reversed and it goes back on the board.') && run({ t: 'clue.cancel' })}>
          Throw out clue
        </Button>
      </div>

      {(clue.attempts.length > 0 || clue.judgments.length > 0) && (
        <div className="hc-log">
          {clue.attempts.length > 0 && (
            <div>
              <span className="bz-eyebrow">Buzz order · {pub.buzzer.arbitration === 'latencyAdjusted' ? 'adjusted for ping' : 'as the server received it'}</span>
              <BuzzLadder attempts={clue.attempts} players={players} adjusted={pub.buzzer.arbitration === 'latencyAdjusted'} limit={8} />
            </div>
          )}
          <ul className="hc-log__notes">
            {clue.judgments.map((j, i) => (
              <li key={i} data-correct={j.correct}>
                {players[j.playerId]?.name} {j.correct ? 'correct' : 'incorrect'} <b className="bz-num">{fmtDelta(j.delta)}</b>
              </li>
            ))}
            {clue.excluded.length > 0 && clue.stage !== 'result' && <li>Locked out: {clue.excluded.map((id) => players[id]?.name).join(', ')}</li>}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The roll for the first pick. It runs itself; the host can only hurry it or skip it. */
function RollStage({ pub, players, run, round, roll }: StageProps & { round: TriviaPublic; roll: NonNullable<TriviaPublic['roll']> }) {
  const tied = roll.phase === 'tied' ? rollLeaders(roll) : [];
  const winner = roll.winnerId ? players[roll.winnerId] : null;
  const waiting = roll.contenders.filter((id) => roll.rolls[id] === undefined);
  const title = winner
    ? `${winner.name} picks first`
    : tied.length
      ? `A tie: ${tied.map((id) => players[id]?.name).join(' and ')} roll again`
      : waiting.length
        ? `Waiting for ${plural(waiting.length, 'roll')}`
        : 'The dice are landing…';
  return (
    <section className="hc-card hc-stage" data-tone={winner ? 'buzz' : undefined}>
      <div className="hc-stage__head">
        <div>
          <span className="bz-eyebrow">
            {round.title} · {roll.round === 1 ? 'rolling for the first pick' : `tie-break ${roll.round - 1}`}
          </span>
          <h1>{title}</h1>
        </div>
      </div>
      <ul className="hc-rolls">
        {pub.players
          .filter((p) => roll.contenders.includes(p.id) || roll.out[p.id] !== undefined)
          .map((p) => (
            <li key={p.id} data-out={!roll.contenders.includes(p.id) || undefined} data-winner={p.id === roll.winnerId || undefined}>
              <Avatar avatar={p.avatar} size={28} dim={!roll.contenders.includes(p.id)} />
              <strong>{p.name}</strong>
              <Die value={roll.rolls[p.id] ?? roll.out[p.id] ?? null} />
            </li>
          ))}
      </ul>
      <div className="hc-actions">
        <Button variant="primary" size="l" hotkey="Space" disabled={roll.phase !== 'rolling' || pub.paused} onClick={() => run({ t: 'roll.finish' })}>
          Roll for everyone who hasn’t
        </Button>
      </div>
      <p className="hc-note">
        Players tap their phone to roll. The highest roll picks the first clue, and ties roll again automatically. There’s no clock, so use the button above to
        roll for anyone who’s away. To skip the roll, click a player and give them the board.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- fast money

export function FastMoneyStage({ pub, snap, players, run, round, secret }: StageProps & { round: FastMoneyPublic; secret: FastMoneySecret }) {
  const active = round.turns[round.turn] ?? [];
  const names = active.map((id) => players[id]?.name).filter(Boolean).join(', ') || 'Nobody';
  const nextCell = secret.revealStep < secret.revealLimit ? secret.cells[Math.floor(secret.revealStep / 2)] : null;
  const nextIsPoints = secret.revealStep % 2 === 1;
  const moreTurns = round.turn < round.turns.length - 1;
  const stepName = (cell: { turn: number; q: number }) => `${round.turns[cell.turn].length === 1 ? (players[round.turns[cell.turn][0]]?.name ?? 'Player') : 'Everyone'} · Q${cell.q + 1}`;
  const shown = (turn: number, q: number) => {
    const i = secret.cells.findIndex((c) => c.turn === turn && c.q === q);
    return Math.max(0, Math.min(2, secret.revealStep - i * 2));
  };

  return (
    <section className="hc-card hc-stage" data-stage={round.stage}>
      <div className="hc-stage__head">
        <div>
          <span className="bz-eyebrow">
            {round.title} · {round.stakes === 'decider' ? 'highest survey total wins the game' : `${round.multiplier} points per survey point`}
            {round.target > 0 && ` · target ${round.target}`}
          </span>
          <h1>
            {round.stage === 'ready' && `Up: ${names}`}
            {round.stage === 'answering' && `${names} answering`}
            {round.stage === 'reveal' && 'Reveal the answers'}
            {(round.stage === 'result' || round.stage === 'done') && 'Result is on screen'}
          </h1>
        </div>
        <TimerTools pub={pub} snap={snap} run={run} running={!!round.timer} />
      </div>
      <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />

      {round.stage === 'ready' && (
        <p>
          {round.participants === 'all'
            ? 'Everyone answers on their phone at the same time.'
            : `Read the questions out as they answer on their phone${round.turn > 0 && round.blockDuplicates ? '. Repeating an earlier answer gets the buzzer' : ''}.`}
          {round.revealMode === 'afterEachTurn' && moreTurns && ' The next contestant shouldn’t see or hear this turn.'}
        </p>
      )}

      <div className="hc-actions">
        {round.stage === 'ready' && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'fm.start' })}>
            Start the clock
          </Button>
        )}
        {round.stage === 'answering' && (
          <Button variant="ghost" size="l" onClick={() => run({ t: 'fm.endTurn' })}>
            End turn now
          </Button>
        )}
        {round.stage === 'reveal' && nextCell && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'fm.reveal' })}>
            {nextIsPoints ? 'Survey says… (points)' : 'Show answer'} · {stepName(nextCell)}
          </Button>
        )}
        {round.stage === 'reveal' && !nextCell && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'fm.next' })}>
            {moreTurns ? 'Next contestant' : 'Show the result'}
          </Button>
        )}
        {round.stage === 'result' && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'round.end' })}>
            {pub.roundIndex === pub.rounds.length - 1 ? 'Finish the game' : 'Finish round'}
          </Button>
        )}
      </div>

      {round.stage !== 'ready' || round.turn > 0 ? (
        <div className="hc-fm">
          {round.questions.map((question, q) => (
            <div key={q} className="hc-fm__q">
              <header>
                <b className="bz-num">{q + 1}</b>
                <span>{question}</span>
                <small>{secret.surveys[q].answers.map((a) => `${a.text} ${a.points}`).join(' · ')}</small>
              </header>
              {round.turns.map((group, turn) =>
                group.map((id) => {
                  const response = secret.responses[id]?.[q];
                  if (!response || turn > round.turn) return null;
                  const state = shown(turn, q);
                  return (
                    <FmRow
                      key={id}
                      name={players[id]?.name ?? '–'}
                      response={response}
                      answers={secret.surveys[q].answers}
                      state={state}
                      next={nextCell?.turn === turn && nextCell.q === q}
                      editable={round.stage !== 'result' && round.stage !== 'done'}
                      onMatch={(match) => run({ t: 'fm.override', playerId: id, q, match })}
                      onText={(text) => run({ t: 'fm.setAnswer', playerId: id, q, text })}
                    />
                  );
                }),
              )}
            </div>
          ))}
        </div>
      ) : null}
      {round.stage !== 'ready' && (
        <p className="hc-note">
          A match marked “close” allowed for a typo, so check it before you reveal. You can change any match, or type in an answer a player said out loud.
        </p>
      )}
    </section>
  );
}

function FmRow({ name, response, answers, state, next, editable, onMatch, onText }: {
  name: string;
  response: FastMoneySecret['responses'][string][number];
  answers: { text: string; points: number }[];
  state: number;
  next: boolean;
  editable: boolean;
  onMatch: (match: number | null) => void;
  onText: (text: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="hc-fm__row" data-next={next || undefined} data-shown={state}>
      <strong>{name}</strong>
      {editable && state === 0 ? (
        <input
          className="bz-input"
          value={text ?? response.text}
          placeholder="no answer yet"
          maxLength={80}
          aria-label={`${name}'s answer`}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text !== null && text.trim() !== response.text) onText(text.trim());
            setText(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      ) : (
        <span className="hc-fm__text">{response.text || '–'}</span>
      )}
      <select className="bz-select" value={response.match ?? ''} disabled={!editable} aria-label={`Survey match for ${name}`} onChange={(e) => onMatch(e.target.value === '' ? null : Number(e.target.value))}>
        <option value="">No match · 0</option>
        {answers.map((a, i) => (
          <option key={i} value={i}>
            {a.text} · {a.points}
          </option>
        ))}
      </select>
      <span className={cx('bz-pill', response.matchedBy === 'fuzzy' && 'bz-pill--buzz', response.matchedBy === 'host' && 'bz-pill--cyan')}>
        {response.matchedBy === 'fuzzy' ? 'close' : response.matchedBy === 'host' ? 'set by you' : response.matchedBy === 'exact' ? 'exact' : '–'}
      </span>
      <b className="bz-num">{response.points}</b>
    </div>
  );
}

// ---------------------------------------------------------------- final

export function FinalStage({ pub, snap, players, run, round, secret }: StageProps & { round: FinalPublic; secret: FinalSecret }) {
  const current = secret.current ? players[secret.current] : null;
  const currentReveal = round.reveals.at(-1);
  const judged = currentReveal ? currentReveal.correct !== null : true;
  const allDone = round.stage === 'reveal' && round.remaining === 0 && judged;

  return (
    <section className="hc-card hc-stage hc-clue" data-stage={round.stage}>
      <div className="hc-stage__head">
        <div>
          <span className="bz-eyebrow">
            {round.title} · {round.category}
          </span>
          <p className="hc-clue__state">
            {round.stage === 'wager' && `Wagers: ${round.wagered.length} of ${round.players.length} in`}
            {round.stage === 'answering' && `Answers: ${round.answered.length} of ${round.players.length} in`}
            {round.stage === 'reveal' && (allDone ? 'Every answer is revealed' : `Revealing · ${round.remaining} to go`)}
          </p>
        </div>
        <TimerTools pub={pub} snap={snap} run={run} running={!!round.timer} />
      </div>
      <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} />

      <p className="hc-clue__q">{secret.question}</p>
      <div className="hc-clue__answer">
        <span className="bz-eyebrow">Answer</span>
        <strong>{secret.answer}</strong>
        {!!secret.accept.length && <span>Also accept: {secret.accept.join(' · ')}</span>}
        {secret.notes && <em>{secret.notes}</em>}
      </div>

      {round.stage === 'reveal' && current && currentReveal && (
        <div className="hc-answering">
          <Avatar avatar={current.avatar} size={52} />
          <div>
            <span className="bz-eyebrow">
              {current.name} wrote · wagered {fmtScore(secret.wagers[current.id] ?? 0)}
            </span>
            <strong>{currentReveal.answer || '(nothing)'}</strong>
          </div>
          {secret.suggestion !== null && <span className={cx('bz-pill', secret.suggestion ? 'bz-pill--good' : 'bz-pill--bad')}>{secret.suggestion ? 'Looks right' : 'Doesn’t match'}</span>}
        </div>
      )}

      <div className="hc-actions">
        {round.stage === 'wager' && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'final.advance' })}>
            Close wagers &amp; show the question
          </Button>
        )}
        {round.stage === 'answering' && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'final.advance' })}>
            Pens down
          </Button>
        )}
        {round.stage === 'reveal' && !judged && (
          <>
            <Button variant="good" size="l" hotkey="C" disabled={pub.paused} onClick={() => run({ t: 'final.judge', correct: true })}>
              Correct
            </Button>
            <Button variant="bad" size="l" hotkey="X" disabled={pub.paused} onClick={() => run({ t: 'final.judge', correct: false })}>
              Incorrect
            </Button>
          </>
        )}
        {round.stage === 'reveal' && judged && !allDone && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'final.show' })}>
            Show next answer
          </Button>
        )}
        {allDone && (
          <Button variant="primary" size="l" hotkey="Space" disabled={pub.paused} onClick={() => run({ t: 'round.end' })}>
            {pub.roundIndex === pub.rounds.length - 1 ? 'Finish the game' : 'Finish round'}
          </Button>
        )}
      </div>

      <ul className="hc-finalists">
        {round.players.map((id) => {
          const p = players[id];
          const reveal = round.reveals.find((r) => r.playerId === id);
          return p ? (
            <li key={id} data-correct={reveal?.correct ?? undefined}>
              <Avatar avatar={p.avatar} size={28} />
              <strong>{p.name}</strong>
              <span>{secret.wagers[id] === undefined ? 'no wager yet' : `wager ${fmtScore(secret.wagers[id])}`}</span>
              <span className="hc-finalists__answer">{round.stage === 'wager' ? '' : (secret.answers[id] ?? '–')}</span>
              {reveal?.delta != null && <b className="bz-num">{fmtDelta(reveal.delta)}</b>}
            </li>
          ) : null;
        })}
      </ul>
    </section>
  );
}
