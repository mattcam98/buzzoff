/** Small labelled form controls shared by the rules and pack editors. */
import { useEffect, useState, type ReactNode } from 'react';

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * A whole-number input. It keeps the raw text while you type (so a field can
 * be emptied and retyped) and only reports valid numbers, clamping on blur.
 */
export function NumField(props: { label: string; help?: ReactNode; value: number; min: number; max: number; step?: number; onChange: (n: number) => void; className?: string }) {
  const { label, help, value, min, max, step, onChange, className } = props;
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  return (
    <label className={`bz-field ${className ?? ''}`}>
      <span>{label}</span>
      <input
        className="bz-input"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step ?? 1}
        value={text}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          const n = Number(text);
          onChange(text.trim() !== '' && Number.isFinite(n) ? clamp(Math.round(n), min, max) : value);
        }}
        onChange={(e) => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
      />
      {help && <small>{help}</small>}
    </label>
  );
}

export function SelectField<T extends string>(props: { label: string; help?: ReactNode; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <label className="bz-field">
      <span>{props.label}</span>
      <select className="bz-select" value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {props.help && <small>{props.help}</small>}
    </label>
  );
}

export function ToggleField(props: { label: string; help?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="mg-toggle">
      <label className="bz-toggle">
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
        <span>{props.label}</span>
      </label>
      {props.help && <small>{props.help}</small>}
    </div>
  );
}

/**
 * Edits a list of strings as free text, split on commas or on new lines. The
 * text is kept locally so separators survive while typing; give it a `key`
 * that changes when the underlying item does.
 */
export function ListField(props: { label: string; help?: ReactNode; value: string[]; onChange: (v: string[]) => void; by: 'comma' | 'line'; placeholder?: string }) {
  const { by, value, onChange } = props;
  const [text, setText] = useState(() => value.join(by === 'comma' ? ', ' : '\n'));
  const parse = (raw: string) =>
    raw
      .split(by === 'comma' ? /[,\n]/ : /\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  const change = (raw: string) => {
    setText(raw);
    onChange(parse(raw));
  };
  return (
    <label className="bz-field">
      <span>{props.label}</span>
      {by === 'comma' ? (
        <input className="bz-input" value={text} placeholder={props.placeholder} onChange={(e) => change(e.target.value)} />
      ) : (
        <textarea className="bz-textarea" rows={2} value={text} placeholder={props.placeholder} onChange={(e) => change(e.target.value)} />
      )}
      {props.help && <small>{props.help}</small>}
    </label>
  );
}

/** Up / down / remove controls for an item in an ordered list. */
export function RowTools(props: { index: number; count: number; what: string; onMove: (to: number) => void; onRemove?: () => void }) {
  const { index, count, what, onMove, onRemove } = props;
  return (
    <span className="mg-tools">
      <button type="button" className="mg-tool" disabled={index === 0} onClick={() => onMove(index - 1)} aria-label={`Move ${what} up`} title="Move up">
        ↑
      </button>
      <button type="button" className="mg-tool" disabled={index === count - 1} onClick={() => onMove(index + 1)} aria-label={`Move ${what} down`} title="Move down">
        ↓
      </button>
      {onRemove && (
        <button type="button" className="mg-tool mg-tool--bad" onClick={onRemove} aria-label={`Remove ${what}`} title="Remove">
          ✕
        </button>
      )}
    </span>
  );
}

export function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export const shortId = () => Math.random().toString(36).slice(2, 9);
