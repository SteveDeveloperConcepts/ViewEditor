// "Create asset": makes backgrounds and title cards on this computer and saves them to the asset library.

import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Info, Save } from 'lucide-react';
import type { AiTask } from '@shared/ai';
import { DEFAULT_TEXT_STYLE, FONT_FAMILIES, SIZE_PRESETS } from '@shared/constants';
import type { TextItem } from '@shared/types';
import { AiForm } from '@/ai/AiForm';
import { JobList } from '@/ai/JobList';
import { Button, ColorField, Field, Notice, Segmented, Slider } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { canvasBytes } from '@/lib/media';
import { drawTextItem, textHeight } from '@/lib/textRender';
import { reportRejected } from '@/editor/importing';
import { navigate, toast } from '@/store/ui';

type Kind = 'gradient' | 'glow' | 'stripes' | 'solid';

const PALETTES: [string, string][] = [
  ['#1d2b53', '#7c3aed'],
  ['#0f766e', '#a3e635'],
  ['#7c2d12', '#f59e0b'],
  ['#be123c', '#fb7185'],
  ['#0f172a', '#38bdf8'],
  ['#f8fafc', '#cbd5e1'],
];

interface Design {
  kind: Kind;
  a: string;
  b: string;
  angle: number;
  title: string;
  font: string;
  textColor: string;
}

function draw(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, h: number, d: Design): void {
  ctx.clearRect(0, 0, w, h);
  if (d.kind === 'solid') {
    ctx.fillStyle = d.a;
    ctx.fillRect(0, 0, w, h);
  } else if (d.kind === 'gradient') {
    const r = (d.angle * Math.PI) / 180;
    const len = Math.abs(w * Math.sin(r)) + Math.abs(h * Math.cos(r));
    const dx = (Math.sin(r) * len) / 2;
    const dy = (Math.cos(r) * len) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx, h / 2 + dy, w / 2 + dx, h / 2 - dy);
    g.addColorStop(0, d.a);
    g.addColorStop(1, d.b);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else if (d.kind === 'glow') {
    ctx.fillStyle = d.a;
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.42, Math.max(w, h) * 0.62);
    g.addColorStop(0, d.b);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = d.a;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((d.angle * Math.PI) / 180);
    ctx.fillStyle = d.b;
    const span = Math.hypot(w, h);
    const band = span / 14;
    for (let x = -span; x < span; x += band * 2) ctx.fillRect(x, -span, band, span * 2);
    ctx.restore();
  }
  if (d.title.trim()) {
    const size = Math.min(w, h) * 0.11;
    const style = { ...DEFAULT_TEXT_STYLE, fontFamily: d.font, fontSize: size, color: d.textColor, bgPadding: 0, shadow: true, strokeWidth: 0 };
    const boxW = w * 0.84;
    const boxH = textHeight(d.title, style, boxW);
    const item: TextItem = {
      id: 'title', type: 'text', trackId: '', start: 0, duration: 1, groupId: null, text: d.title, style, opacity: 1, subtitle: false,
      x: (w - boxW) / 2, y: (h - boxH) / 2, w: boxW, h: boxH,
    };
    drawTextItem(ctx, item, 1);
  }
}

const AI_TASKS: { task: AiTask; label: string; placeholder: string }[] = [
  { task: 'text-to-video', label: 'Text to video', placeholder: 'A slow aerial shot over a coastline at sunrise' },
  { task: 'image-to-video', label: 'Image to video', placeholder: 'The product turns slowly on a marble table' },
  { task: 'text-to-image', label: 'Text to image', placeholder: 'A clean product photo on a warm background' },
];

function AiCreator(): ReactNode {
  const [task, setTask] = useState<AiTask>('text-to-video');
  const [aspect, setAspect] = useState('16:9');
  const preset = SIZE_PRESETS.find((p) => p.id === aspect) ?? SIZE_PRESETS[0];
  const current = AI_TASKS.find((t) => t.task === task)!;
  return (
    <div className="create-layout">
      <div className="create-jobs">
        <JobList projectId={null} />
        <p className="faint">What you generate here is saved under Assets, ready to use in any project.</p>
      </div>
      <div className="create-controls">
        <Field label="Create">
          <Segmented<AiTask> fill label="What to create" value={task} options={AI_TASKS.map((t) => ({ value: t.task, label: t.label }))} onChange={setTask} />
        </Field>
        <Field label="Made for">
          <select className="select" value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {SIZE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} · {p.hint}
              </option>
            ))}
          </select>
        </Field>
        <AiForm key={`${task}${aspect}`} task={task} projectId={null} placement={{ kind: 'none' }} width={preset.width} height={preset.height} promptPlaceholder={current.placeholder} />
      </div>
    </div>
  );
}

export function CreateAssetPage(): ReactNode {
  const [mode, setMode] = useState<'ai' | 'design'>('ai');
  return (
    <div className="page">
      <header className="page-head">
        <h1>Create asset</h1>
        <Segmented<'ai' | 'design'>
          label="How to create"
          value={mode}
          options={[
            { value: 'ai', label: 'With AI' },
            { value: 'design', label: 'Backgrounds and title cards' },
          ]}
          onChange={setMode}
        />
      </header>
      {mode === 'ai' ? <AiCreator /> : <Designer />}
    </div>
  );
}

function Designer(): ReactNode {
  const [design, setDesign] = useState<Design>({ kind: 'gradient', a: PALETTES[0][0], b: PALETTES[0][1], angle: 135, title: '', font: FONT_FAMILIES[0], textColor: '#ffffff' });
  const [aspect, setAspect] = useState('16:9');
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const preset = SIZE_PRESETS.find((p) => p.id === aspect) ?? SIZE_PRESETS[0];
  const patch = (p: Partial<Design>): void => setDesign((d) => ({ ...d, ...p }));

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const s = 640 / Math.max(preset.width, preset.height);
    el.width = Math.round(preset.width * s);
    el.height = Math.round(preset.height * s);
    draw(el.getContext('2d')!, el.width, el.height, design);
  }, [design, preset]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const out = new OffscreenCanvas(preset.width, preset.height);
      draw(out.getContext('2d')!, preset.width, preset.height, design);
      const label = design.title.trim() ? design.title.trim().slice(0, 40) : `${design.kind[0].toUpperCase()}${design.kind.slice(1)} ${aspect}`;
      const result = await api.assets.importData(`${label.replace(/[:/\\]/g, '-')}.png`, await canvasBytes(out, 'image/png'), { scope: 'workspace' });
      reportRejected(result);
      if (result.assets.length) {
        toast('Saved to your assets.', { kind: 'success', action: { label: 'View', run: () => void navigate({ page: 'assets' }) } });
      }
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="create-layout">
        <div className="create-preview">
          <canvas ref={canvas} aria-label="Preview" />
        </div>
        <div className="create-controls">
          <Field label="Style">
            <Segmented<Kind>
              fill
              label="Style"
              value={design.kind}
              options={[
                { value: 'gradient', label: 'Gradient' },
                { value: 'glow', label: 'Glow' },
                { value: 'stripes', label: 'Stripes' },
                { value: 'solid', label: 'Solid' },
              ]}
              onChange={(kind) => patch({ kind })}
            />
          </Field>
          <div className="field">
            <span className="label">Colours</span>
            <div className="swatches">
              {PALETTES.map(([a, b]) => (
                <button key={a + b} type="button" className="swatch" style={{ background: `linear-gradient(135deg, ${a}, ${b})` }} aria-label={`Palette ${a} and ${b}`} aria-pressed={design.a === a && design.b === b} onClick={() => patch({ a, b })} />
              ))}
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <span className="label">First colour</span>
              <ColorField label="First colour" value={design.a} onChange={(a) => patch({ a })} />
            </div>
            {design.kind !== 'solid' && (
              <div className="field">
                <span className="label">Second colour</span>
                <ColorField label="Second colour" value={design.b} onChange={(b) => patch({ b })} />
              </div>
            )}
          </div>
          {(design.kind === 'gradient' || design.kind === 'stripes') && (
            <div className="field">
              <span className="label">Angle · {design.angle}°</span>
              <Slider label="Angle" min={0} max={360} step={5} value={design.angle} onChange={(angle) => patch({ angle })} />
            </div>
          )}
          <Field label="Title (optional)">
            <input className="input" placeholder="Add words to make a title card" value={design.title} maxLength={120} onChange={(e) => patch({ title: e.target.value })} />
          </Field>
          {design.title.trim() && (
            <div className="form-grid">
              <Field label="Font">
                <select className="select" value={design.font} onChange={(e) => patch({ font: e.target.value })}>
                  {FONT_FAMILIES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="field">
                <span className="label">Text colour</span>
                <ColorField label="Text colour" value={design.textColor} onChange={(textColor) => patch({ textColor })} />
              </div>
            </div>
          )}
          <Field label="Size">
            <select className="select" value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {SIZE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.width} × {p.height}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="primary" size="large" icon={<Save size={15} />} disabled={saving} onClick={() => void save()}>
            Save to assets
          </Button>
          <Notice icon={<Info size={14} />}>Made on this computer. Saved assets appear under Assets, ready to use in any project.</Notice>
        </div>
      </div>
    </>
  );
}
