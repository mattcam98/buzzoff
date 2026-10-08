/** The in-round scenes of the shared screen, one per game mode. */
import type { FastMoneyPublic, FinalPublic, Media, TriviaPublic } from '@buzzoff/shared';
import { fmtDelta, fmtScore } from '../../lib/format';
import { BuzzLadder, Seconds, textScale } from '../../ui/game';
import { Avatar, cx, TimerBar } from '../../ui/kit';
import type { SceneProps } from '../Tv';

export function MediaView({ media, className }: { media: Media; className?: string }) {
  if (media.kind === 'image') return <img className={cx('bz-media', className)} src={media.url} alt="" />;
  if (media.kind === 'audio') {
    return (
      <div className={cx('bz-media bz-media--audio', className)}>
        <span aria-hidden>🎧</span>
        <audio src={media.url} autoPlay controls />
      </div>
    );
  }
  return <video className={cx('bz-media', className)} src={media.url} autoPlay controls playsInline />;
}

// ---------------------------------------------------------------- trivia

export function TriviaScene({ pub, snap, players, round }: SceneProps & { round: TriviaPublic }) {
  const clue = round.clue;
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

      <div className="tv-clue__body" data-media={clue.media?.kind}>
        {clue.media && <MediaView media={clue.media} className="tv-clue__media" />}
        <p className="tv-clue__q" data-scale={textScale(clue.question ?? '')}>
          {clue.question}
        </p>
      </div>

      <TimerBar timer={clue.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} className="tv-clue__timer" />

      <div className="tv-clue__status" key={`${clue.stage}-${clue.answererId}-${clue.judgments.length}`}>
        {clue.stage === 'reading' && (
          <div className="tv-status tv-status--locked">
            <span aria-hidden>🔒</span> Buzzers locked
          </div>
        )}
        {clue.stage === 'open' && (
          <div className="tv-status tv-status--open">
            {clue.collecting ? 'Buzz received…' : clue.judgments.length ? 'Steal it — buzz!' : 'Buzz!'}
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
              <small>{pub.buzzer.arbitration === 'latencyAdjusted' ? 'Server-recorded times, adjusted for each player’s ping' : 'Times as recorded by the server'}</small>
            </div>
          </div>
        )}
        {clue.stage === 'result' && (
          <div className="tv-result">
            <div className="tv-result__answer">
              <span className="bz-eyebrow">{clue.timedOut ? 'Time’s up — the answer was' : 'Answer'}</span>
              <strong>{clue.answer}</strong>
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

function Board({ round, players }: { round: TriviaPublic; players: SceneProps['players'] }) {
  const picker = round.controlId ? players[round.controlId] : null;
  const rows = Math.max(...round.board.map((c) => c.clues.length));
  return (
    <div className="tv-board-wrap">
      <div className="tv-board" style={{ gridTemplateColumns: `repeat(${round.board.length}, 1fr)`, gridTemplateRows: `auto repeat(${rows}, 1fr)` }}>
        {round.board.map((cat, c) => (
          <div key={`h${c}`} className="tv-board__cat" style={{ gridColumn: c + 1, animationDelay: `${c * 70}ms` }}>
            {cat.title}
          </div>
        ))}
        {round.board.flatMap((cat, c) =>
          cat.clues.map((cl, k) => (
            <div key={`${c}-${k}`} className="tv-board__cell" data-used={cl.used || undefined} style={{ gridColumn: c + 1, gridRow: k + 2, animationDelay: `${200 + (c + k) * 45}ms` }}>
              {cl.used ? cl.winnerId && players[cl.winnerId] ? <Avatar avatar={players[cl.winnerId].avatar} size="1.5em" /> : null : <span className="bz-num">{fmtScore(cl.value)}</span>}
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

  const banner =
    round.stage === 'ready' ? (crowd ? 'Phones at the ready…' : `${players[active[0]]?.name ?? 'Next contestant'}, you’re up`) :
    round.stage === 'answering' ? (crowd ? 'Answer on your phone!' : `${players[active[0]]?.name ?? ''} is answering`) :
    round.stage === 'reveal' ? 'Survey says…' :
    round.outcome && round.stakes === 'decider' ? `${winners.map((id) => players[id]?.name).filter(Boolean).join(' & ')} ${winners.length > 1 ? 'tie it' : 'wins it'}!` :
    round.outcome?.targetHit ? 'Jackpot!' : round.outcome?.targetHit === false ? 'So close…' : 'Final totals';

  return (
    <div className="tv-fm" data-stage={round.stage} data-crowd={crowd || undefined}>
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
        <div className="tv-fm__board" style={{ gridTemplateColumns: `minmax(0, 1.5fr) repeat(${contestants.length}, minmax(0, 1fr))` }}>
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
                {round.stage === 'ready' && round.turn === 0 ? <i>Question {i + 1}</i> : q}
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
                          <span className="tv-fm__answer" key={cell?.text ?? 'x'}>{cell?.text === null ? '' : cell?.text || '—'}</span>
                          <b className="bz-num" key={`p${cell?.points}`}>{cell?.points ?? ''}</b>
                        </>
                      )}
                    </div>
                  );
                }),
              )}
              {(round.stage === 'result' || round.stage === 'done') && round.topAnswers[i] && (
                <div className="tv-fm__top" style={{ gridColumn: `1 / -1` }}>
                  No. 1 answer: <strong>{round.topAnswers[i]!.text}</strong> <b className="bz-num">{round.topAnswers[i]!.points}</b>
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
  if (round.stage === 'ready' || round.stage === 'answering') {
    return (
      <ul className="tv-crowd__progress">
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
      <ol className="tv-crowd__totals">
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
      <ul className="tv-crowd__answers">
        {ids.map((id, i) => {
          const p = players[id];
          const cell = round.cells[id]?.[focusQ];
          if (!p || !cell || cell.text === null) return null;
          return (
            <li key={id} data-zero={cell.points === 0 || undefined} data-scored={cell.points !== null || undefined} style={{ animationDelay: `${i * 60}ms` }}>
              <Avatar avatar={p.avatar} size="1.7em" />
              <span>
                <small>{p.name}</small>
                {cell.text || '—'}
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
        <div className="tv-clue__body" data-media={round.media?.kind}>
          {round.media && <MediaView media={round.media} className="tv-clue__media" />}
          <p className="tv-clue__q" data-scale={textScale(round.question ?? '')}>
            {round.question}
          </p>
        </div>
      )}

      <TimerBar timer={round.timer} clockOffset={snap.clockOffset} pausedAt={pub.pausedAt} className="tv-clue__timer" />

      {(round.stage === 'wager' || round.stage === 'answering') && (
        <div className="tv-final__waiting">
          <Seconds pub={pub} snap={snap} className="tv-status__count" />
          <ul>
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
              <strong>{round.answer}</strong>
            </div>
          ) : current && currentPlayer ? (
            <div className="tv-final__card" key={current.playerId} data-correct={current.correct ?? undefined}>
              <Avatar avatar={currentPlayer.avatar} size="4.4em" />
              <div>
                <span className="bz-eyebrow">{currentPlayer.name} wrote</span>
                <strong>{current.answer || 'Nothing at all'}</strong>
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
            {round.reveals.filter((r) => r.correct !== null && (round.answer || r !== current)).map((r) => {
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
