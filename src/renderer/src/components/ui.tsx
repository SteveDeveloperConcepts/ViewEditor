import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { formatTimecode, parseTimecode } from '@shared/time';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'small' | 'medium' | 'large';
  block?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = 'default', size = 'medium', block, icon, className, children, ...rest }: ButtonProps): ReactNode {
  const cls = ['btn', variant !== 'default' && variant, size !== 'medium' && size, block && 'block', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; small?: boolean };

/** A button that shows only an icon; `label` names it for tooltips and screen readers. */
export function IconButton({ label, active, small, className, children, ...rest }: IconButtonProps): ReactNode {
  const cls = ['icon-btn', active && 'active', small && 'small', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} title={label} aria-label={label} {...rest}>
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }): ReactNode {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  onChange: (v: number) => void;
  /** Fired when the user lets go, for work that should happen once per drag. */
  onCommit?: () => void;
}): ReactNode {
  const { value, min, max, step = 1, label, onChange, onCommit } = props;
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <input
      type="range"
      className="slider"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--fill': fill } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
    />
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  fill?: boolean;
  label: string;
}): ReactNode {
  return (
    <div className={`segmented${props.fill ? ' fill' : ''}`} role="group" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" title={o.title} aria-pressed={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** A label on the left and a compact control on the right. */
export function FieldRow({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="field-row">
      <span className="label">{label}</span>
      {children}
    </div>
  );
}

export function Spinner({ large }: { large?: boolean }): ReactNode {
  return <span className={`spinner${large ? ' large' : ''}`} role="status" aria-label="Working" />;
}

export function ProgressBar({ value }: { value: number }): ReactNode {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Notice({ kind = 'info', icon, children }: { kind?: 'info' | 'warning' | 'error'; icon: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className={`notice${kind === 'info' ? '' : ` ${kind}`}`}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

/** A colour picker with a hex box. Reports only complete, valid colours. */
export function ColorField({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }): ReactNode {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="color-field">
      <input type="color" aria-label={label} value={HEX.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} />
      <input
        className="input small"
        aria-label={`${label} hex value`}
        value={text}
        spellCheck={false}
        maxLength={7}
        onChange={(e) => {
          const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
          setText(v);
          if (HEX.test(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </div>
  );
}

/**
 * A number box that only reports a value when the user finishes typing (Enter or leaving the box),
 * so half-typed numbers never reach the document.
 */
export function NumberInput(props: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  decimals?: number;
  suffix?: string;
  small?: boolean;
}): ReactNode {
  const { value, onCommit, min = -Infinity, max = Infinity, label, decimals = 0, small = true } = props;
  const shown = (v: number): string => (decimals ? v.toFixed(decimals).replace(/\.?0+$/, '') : String(Math.round(v)));
  const [text, setText] = useState(shown(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(shown(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const commit = (): void => {
    const n = Number(text.replace(',', '.'));
    if (text.trim() !== '' && Number.isFinite(n)) {
      const clamped = Math.max(min, Math.min(max, n));
      if (clamped !== value) onCommit(clamped);
      setText(shown(clamped));
    } else setText(shown(value));
  };
  return (
    <input
      className={`input${small ? ' small' : ''} tabular`}
      aria-label={label}
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(shown(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** A time box in minutes:seconds.tenths. */
export function TimeInput({ value, onCommit, label }: { value: number; onCommit: (seconds: number) => void; label: string }): ReactNode {
  const [text, setText] = useState(formatTimecode(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(formatTimecode(value));
  }, [value]);
  const commit = (): void => {
    const t = parseTimecode(text);
    if (t !== null && Math.abs(t - value) > 1e-6) onCommit(t);
    setText(formatTimecode(t ?? value));
  };
  return (
    <input
      className="input small tabular"
      aria-label={label}
      value={text}
      onFocus={(e) => {
        focused.current = true;
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
