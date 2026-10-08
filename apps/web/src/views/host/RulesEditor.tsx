/** A form over the whole of `GameRules`: rounds, buzzer behaviour, teams. */
import {
  BUILTIN_PRESETS,
  type BuzzerRules, type FastMoneyRoundDef, type FinalRoundDef, type GameRules, type RoundDef, type TriviaRoundDef,
} from '@buzzoff/shared';
import { Button } from '../../ui/kit';
import { move, NumField, RowTools, SelectField, ToggleField } from './fields';

const MODE_LABEL: Record<RoundDef['mode'], string> = { trivia: 'Trivia board', fastMoney: 'Fast Money', final: 'Final question' };
export const MODE_ICON: Record<RoundDef['mode'], string> = { trivia: '▦', fastMoney: '⚡', final: '✍' };

/** Starting points for a newly added round: the flagship preset's first round of each kind. */
const TEMPLATE = Object.fromEntries(BUILTIN_PRESETS[0].rules.rounds.toReversed().map((r) => [r.mode, r])) as {
  trivia: TriviaRoundDef;
  fastMoney: FastMoneyRoundDef;
  final: FinalRoundDef;
};

interface Props {
  rules: GameRules;
  /** `structural` is true when rounds were added, removed or reordered. */
  onChange: (rules: GameRules, structural?: boolean) => void;
}

export function RulesEditor({ rules, onChange }: Props) {
  const setRound = (i: number, patch: Partial<RoundDef>) =>
    onChange({ ...rules, rounds: rules.rounds.map((r, k) => (k === i ? ({ ...r, ...patch } as RoundDef) : r)) });
  const setBuzzer = (patch: Partial<BuzzerRules>) => onChange({ ...rules, buzzer: { ...rules.buzzer, ...patch } });
  const b = rules.buzzer;

  return (
    <div className="mg-rules">
      <label className="bz-field">
        <span>Game name</span>
        <input className="bz-input" value={rules.name} maxLength={60} onChange={(e) => onChange({ ...rules, name: e.target.value })} />
        <small>Shown on the TV and in your history.</small>
      </label>

      <section className="mg-rules__group">
        <h3>Rounds</h3>
        <ol className="mg-rounds">
          {rules.rounds.map((round, i) => (
            <li key={i} className="mg-round">
              <div className="mg-round__head">
                <span className="bz-pill bz-pill--cyan">
                  {MODE_ICON[round.mode]} {MODE_LABEL[round.mode]}
                </span>
                <input
                  className="bz-input mg-round__title"
                  value={round.title}
                  maxLength={40}
                  aria-label={`Round ${i + 1} title`}
                  onChange={(e) => setRound(i, { title: e.target.value })}
                />
                <RowTools
                  index={i}
                  count={rules.rounds.length}
                  what={`round ${i + 1}`}
                  onMove={(to) => onChange({ ...rules, rounds: move(rules.rounds, i, to) }, true)}
                  onRemove={rules.rounds.length > 1 ? () => onChange({ ...rules, rounds: rules.rounds.filter((_, k) => k !== i) }, true) : undefined}
                />
              </div>
              <div className="mg-fields">
                {round.mode === 'trivia' && <TriviaFields def={round} set={(p) => setRound(i, p)} />}
                {round.mode === 'fastMoney' && <FastMoneyFields def={round} set={(p) => setRound(i, p)} />}
                {round.mode === 'final' && <FinalFields def={round} set={(p) => setRound(i, p)} />}
              </div>
            </li>
          ))}
        </ol>
        {rules.rounds.length < 8 && (
          <div className="mg-row">
            {(['trivia', 'final', 'fastMoney'] as const).map((mode) => (
              <Button key={mode} size="s" variant="ghost" onClick={() => onChange({ ...rules, rounds: [...rules.rounds, { ...TEMPLATE[mode] }] }, true)}>
                + {MODE_LABEL[mode]}
              </Button>
            ))}
          </div>
        )}
      </section>

      <section className="mg-rules__group">
        <h3>Buzzer</h3>
        <div className="mg-fields">
          <SelectField
            label="Who wins the buzz"
            value={b.arbitration}
            onChange={(arbitration) => setBuzzer({ arbitration })}
            options={[['first', 'First buzz received'], ['latencyAdjusted', 'Latency-adjusted']]}
            help={
              b.arbitration === 'first'
                ? 'The first buzz to reach the server wins. Best when everyone shares a Wi-Fi.'
                : 'For remote players: buzzes are collected briefly, then ranked after subtracting half of each player’s measured round trip.'
            }
          />
          {b.arbitration === 'latencyAdjusted' && (
            <>
              <NumField label="Collection window (ms)" value={b.collectionWindowMs} min={50} max={500} onChange={(collectionWindowMs) => setBuzzer({ collectionWindowMs })} help="How long to wait for other buzzes after the first arrives." />
              <NumField label="Max adjustment (ms)" value={b.maxCompensationMs} min={0} max={300} onChange={(maxCompensationMs) => setBuzzer({ maxCompensationMs })} help="The most any one buzz can be moved forward." />
            </>
          )}
          <NumField label="Question timer (s)" value={b.buzzSec} min={0} max={120} onChange={(buzzSec) => setBuzzer({ buzzSec })} help="Buzzers open as soon as you select a clue, and players have this long to buzz. 0 turns the timer off." />
          <NumField label="Time to answer (s)" value={b.answerSec} min={0} max={120} onChange={(answerSec) => setBuzzer({ answerSec })} help="0 turns the timer off. The host always makes the call." />
          <NumField label="Wrong-answer penalty (%)" value={b.incorrectPenaltyPct} min={0} max={100} onChange={(incorrectPenaltyPct) => setBuzzer({ incorrectPenaltyPct })} help="Share of the clue value deducted. 0 means no penalty." />
        </div>
        <div className="mg-toggles">
          <ToggleField label="Steals" checked={b.reopenOnIncorrect} onChange={(reopenOnIncorrect) => setBuzzer({ reopenOnIncorrect })} help="After a wrong answer, re-arm the buzzers for everyone else." />
          <ToggleField label="Second chances" checked={b.rebuzz} onChange={(rebuzz) => setBuzzer({ rebuzz })} help="A player who got it wrong may buzz again on the same clue." />
          {rules.teams.enabled && (
            <ToggleField label="Team lockout" checked={b.teamLockout} onChange={(teamLockout) => setBuzzer({ teamLockout })} help="A wrong answer locks out the whole team." />
          )}
        </div>
      </section>

      <section className="mg-rules__group">
        <h3>Players</h3>
        <div className="mg-fields">
          <NumField label="Max players" value={rules.maxPlayers} min={1} max={50} onChange={(maxPlayers) => onChange({ ...rules, maxPlayers })} />
        </div>
        <div className="mg-toggles">
          <ToggleField label="Late joining" checked={rules.lateJoin} onChange={(lateJoin) => onChange({ ...rules, lateJoin })} help="Let people join after the game has started." />
          <ToggleField label="Teams" checked={rules.teams.enabled} onChange={(enabled) => onChange({ ...rules, teams: { ...rules.teams, enabled } })} help="Players are split into teams; team scores add up." />
        </div>
        {rules.teams.enabled && (
          <div className="mg-teams">
            {rules.teams.names.map((name, i) => (
              <div key={i} className="mg-team">
                <input
                  className="bz-input"
                  value={name}
                  maxLength={24}
                  aria-label={`Team ${i + 1} name`}
                  onChange={(e) => onChange({ ...rules, teams: { ...rules.teams, names: rules.teams.names.map((n, k) => (k === i ? e.target.value : n)) } })}
                />
                {rules.teams.names.length > 2 && (
                  <button
                    type="button"
                    className="mg-tool mg-tool--bad"
                    aria-label={`Remove team ${i + 1}`}
                    onClick={() => onChange({ ...rules, teams: { ...rules.teams, names: rules.teams.names.filter((_, k) => k !== i) } })}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {rules.teams.names.length < 6 && (
              <Button size="s" variant="ghost" onClick={() => onChange({ ...rules, teams: { ...rules.teams, names: [...rules.teams.names, `Team ${rules.teams.names.length + 1}`] } })}>
                + Team
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function TriviaFields({ def, set }: { def: TriviaRoundDef; set: (p: Partial<TriviaRoundDef>) => void }) {
  return (
    <>
      <NumField label="Categories" value={def.categories} min={1} max={8} onChange={(categories) => set({ categories })} />
      <NumField label="Clues per category" value={def.cluesPerCategory} min={1} max={8} onChange={(cluesPerCategory) => set({ cluesPerCategory })} />
      <NumField label="Value multiplier" value={def.valueMultiplier} min={1} max={20} onChange={(valueMultiplier) => set({ valueMultiplier })} help="2 doubles every clue value." />
      <NumField label="Hidden wagers" value={def.wagers} min={0} max={6} onChange={(wagers) => set({ wagers })} help="Wager clues placed at random on the board." />
      <NumField label="Wager cap" value={def.wagerCap} min={0} max={1000000} step={100} onChange={(wagerCap) => set({ wagerCap })} help="Players may wager up to their score, or this if they have less." />
      <NumField label="Eliminate lowest" value={def.eliminateLowest} min={0} max={20} onChange={(eliminateLowest) => set({ eliminateLowest })} help="Knock out this many trailing players when the round ends." />
    </>
  );
}

function FastMoneyFields({ def, set }: { def: FastMoneyRoundDef; set: (p: Partial<FastMoneyRoundDef>) => void }) {
  return (
    <>
      <NumField label="Survey questions" value={def.questions} min={1} max={10} onChange={(questions) => set({ questions })} />
      <SelectField
        label="Who plays"
        value={def.participants}
        onChange={(participants) => set({ participants })}
        options={[['top2', 'Top two, in turn'], ['leader', 'Leader alone'], ['all', 'Everybody at once']]}
      />
      <NumField label="Time per turn (s)" value={def.turnSec} min={10} max={600} onChange={(turnSec) => set({ turnSec })} />
      {def.participants === 'top2' && (
        <NumField label="Extra time for later turns (s)" value={def.extraSecPerTurn} min={0} max={120} onChange={(extraSecPerTurn) => set({ extraSecPerTurn })} help="They have to avoid earlier answers." />
      )}
      <SelectField
        label="Stakes"
        value={def.stakes}
        onChange={(stakes) => set({ stakes })}
        options={[['decider', 'Decider'], ['points', 'Add to scores']]}
        help={def.stakes === 'decider' ? 'Board scores only seed the round: the highest survey total wins the game.' : 'Survey points are added to everyone’s score.'}
      />
      <SelectField
        label="Reveal"
        value={def.reveal}
        onChange={(reveal) => set({ reveal })}
        options={[['atEnd', 'At the end'], ['afterEachTurn', 'After each turn']]}
        help={def.reveal === 'afterEachTurn' ? 'The next contestant should look away during the reveal.' : 'Everyone plays first, then answers are revealed side by side.'}
      />
      {def.stakes === 'points' && (
        <>
          <NumField label="Points per survey point" value={def.pointMultiplier} min={1} max={1000} onChange={(pointMultiplier) => set({ pointMultiplier })} />
          <NumField label="Target (survey points)" value={def.target} min={0} max={100000} onChange={(target) => set({ target })} help="0 means no target." />
          {def.target > 0 && <NumField label="Bonus for hitting the target" value={def.targetBonus} min={0} max={10000000} step={500} onChange={(targetBonus) => set({ targetBonus })} />}
        </>
      )}
      <div className="mg-fields__wide">
        <ToggleField label="Block repeated answers" checked={def.blockDuplicates} onChange={(blockDuplicates) => set({ blockDuplicates })} help="Reject an answer an earlier contestant already gave." />
      </div>
    </>
  );
}

function FinalFields({ def, set }: { def: FinalRoundDef; set: (p: Partial<FinalRoundDef>) => void }) {
  return (
    <>
      <NumField label="Time to wager (s)" value={def.wagerSec} min={0} max={300} onChange={(wagerSec) => set({ wagerSec })} help="0 turns the timer off." />
      <NumField label="Time to answer (s)" value={def.answerSec} min={10} max={600} onChange={(answerSec) => set({ answerSec })} />
      <NumField label="Wager cap" value={def.wagerCap} min={0} max={1000000} step={100} onChange={(wagerCap) => set({ wagerCap })} help="Players may wager up to their score, or this if they have less." />
    </>
  );
}
