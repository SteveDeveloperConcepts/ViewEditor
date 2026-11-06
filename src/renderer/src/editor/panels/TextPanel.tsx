import type { ReactNode } from 'react';
import type { TextStyle } from '@shared/types';
import { addText, type TextKind } from '@/store/editor';

const BASICS: { kind: TextKind; label: string; size: number; weight: number }[] = [
  { kind: 'heading', label: 'Add a heading', size: 22, weight: 700 },
  { kind: 'subheading', label: 'Add a subheading', size: 16, weight: 700 },
  { kind: 'body', label: 'Add body text', size: 13, weight: 400 },
];

const STYLES: { label: string; kind: TextKind; style: Partial<TextStyle>; css: React.CSSProperties }[] = [
  {
    label: 'Label', kind: 'subheading',
    style: { color: '#ffffff', bgColor: '#111111', shadow: false },
    css: { color: '#fff', background: '#111', padding: '2px 8px', borderRadius: 4, fontWeight: 700 },
  },
  {
    label: 'Highlight', kind: 'subheading',
    style: { color: '#111111', bgColor: '#ffe14d', shadow: false },
    css: { color: '#111', background: '#ffe14d', padding: '2px 8px', borderRadius: 4, fontWeight: 700 },
  },
  {
    label: 'Outline', kind: 'heading',
    style: { color: '#ffffff', strokeColor: '#000000', strokeWidth: 10, shadow: false },
    css: { color: '#fff', fontWeight: 800, WebkitTextStroke: '1px #000', paintOrder: 'stroke fill' },
  },
  {
    label: 'IMPACT', kind: 'heading',
    style: { fontFamily: 'Impact', uppercase: true, bold: false, color: '#ffffff' },
    css: { fontFamily: 'Impact, sans-serif', color: '#fff', letterSpacing: '.02em' },
  },
  {
    label: 'Serif', kind: 'heading',
    style: { fontFamily: 'Georgia', bold: false, italic: true },
    css: { fontFamily: 'Georgia, serif', fontStyle: 'italic', color: '#fff' },
  },
  {
    label: 'Mono', kind: 'subheading',
    style: { fontFamily: 'Courier New', bold: true, color: '#7dffb2' },
    css: { fontFamily: '"Courier New", monospace', fontWeight: 700, color: '#7dffb2' },
  },
];

export function TextPanel(): ReactNode {
  return (
    <div className="panel-body">
      <h2 className="panel-title">Text</h2>
      <div className="col">
        {BASICS.map((b) => (
          <button key={b.kind} type="button" className="text-basic" style={{ fontSize: b.size, fontWeight: b.weight }} onClick={() => addText(b.kind)}>
            {b.label}
          </button>
        ))}
      </div>
      <section>
        <h3>Styles</h3>
        <div className="text-style-grid">
          {STYLES.map((s) => (
            <button key={s.label} type="button" className="text-style" onClick={() => addText(s.kind, s.style)}>
              <span style={s.css}>{s.label}</span>
            </button>
          ))}
        </div>
      </section>
      <p className="faint panel-note">Text appears at the playhead. Select it on the canvas or the timeline to change its words, font and colours.</p>
    </div>
  );
}
