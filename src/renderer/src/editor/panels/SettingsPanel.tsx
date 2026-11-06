// Project settings: canvas size, export quality, background, duration, timeline view and frame rate.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Image as ImageIcon, Info, Scaling } from 'lucide-react';
import {
  BACKGROUND_SWATCHES,
  EXPORT_PRESETS,
  FPS_OPTIONS,
  RESOLUTION_OPTIONS,
  SIZE_PRESETS,
  advancedFromPreset,
  aspectLabel,
  defaultBitrate,
  resolutionLabel,
} from '@shared/constants';
import { effectiveAdvanced, effectiveFps, resolveOutputSpec, sourceResolution } from '@shared/render';
import { contentEnd } from '@shared/timeline';
import type { EncodeSpeed, ExportAdvanced, ID, RateControl } from '@shared/types';
import { ColorField, FieldRow, Notice, NumberInput, Segmented, Slider, Switch, TimeInput, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { addAsset, fitItem, setCanvasSize, updateItem, updateSettings, useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { setPrefs, usePrefs } from '@/store/prefs';
import { toast } from '@/store/ui';
import { reportRejected } from '../importing';

async function pickBackgroundImage(projectId: ID): Promise<void> {
  try {
    const result = await api.assets.pickAndImport('image', { scope: 'project', projectId });
    if (!result) return;
    reportRejected(result);
    const asset = result.assets[0];
    if (!asset) return;
    const id = addAsset(asset, { newTrack: 'bottom', at: 0 });
    if (!id) return;
    fitItem(id, 'cover');
    const doc = useEditor.getState().doc;
    if (doc) updateItem(id, { duration: Math.max(1, contentEnd(doc)) });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

export function SizeSelect({ label = 'Canvas size', compact = false }: { label?: string; compact?: boolean }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const { width, height } = doc.settings;
  const match = SIZE_PRESETS.find((p) => Math.abs(p.width / p.height - width / height) < 0.01);
  return (
    <select
      className="select"
      aria-label={label}
      value={match?.id ?? 'custom'}
      onChange={(e) => {
        const p = SIZE_PRESETS.find((x) => x.id === e.target.value);
        if (!p) return;
        // Keep the current sharpness: the new frame gets the same short side as the old one.
        const s = Math.min(width, height) / Math.min(p.width, p.height);
        setCanvasSize(Math.round((p.width * s) / 2) * 2, Math.round((p.height * s) / 2) * 2, 'fill');
      }}
    >
      {!match && <option value="custom">Custom ({aspectLabel(width, height)})</option>}
      {SIZE_PRESETS.map((p) => (
        <option key={p.id} value={p.id}>
          {compact ? p.label : `${p.label} · ${p.hint}`}
        </option>
      ))}
    </select>
  );
}

function AdvancedExport({ value, onChange }: { value: ExportAdvanced; onChange: (patch: Partial<ExportAdvanced>) => void }): ReactNode {
  const fps = useEditor((s) => s.doc?.settings.fps ?? 30);
  return (
    <div className="col">
      <FieldRow label="Resolution">
        <select className="select small fixed" aria-label="Export resolution" value={value.resolution} onChange={(e) => onChange({ resolution: Number(e.target.value) })}>
          {RESOLUTION_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {resolutionLabel(r)}
            </option>
          ))}
        </select>
      </FieldRow>
      <FieldRow label="Bitrate">
        <Segmented<RateControl>
          label="Bitrate mode"
          value={value.rateControl}
          options={[
            { value: 'vbr', label: 'Variable', title: 'Smaller files at higher quality' },
            { value: 'cbr', label: 'Constant', title: 'The same amount of data every second' },
          ]}
          onChange={(rateControl) => onChange({ rateControl, bitrateKbps: value.bitrateKbps || defaultBitrate(value.resolution, fps) })}
        />
      </FieldRow>
      {value.rateControl === 'vbr' ? (
        <div className="field">
          <span className="label">Quality · {value.crf <= 18 ? 'Very high' : value.crf <= 22 ? 'High' : value.crf <= 26 ? 'Medium' : 'Low'}</span>
          {/* Lower CRF means better quality, so the slider runs the other way. */}
          <Slider label="Quality" min={-32} max={-14} value={-value.crf} onChange={(v) => onChange({ crf: -v })} />
        </div>
      ) : (
        <FieldRow label="Target (kbit/s)">
          <div className="fixed">
            <NumberInput label="Target bitrate in kilobits per second" min={500} max={120000} value={value.bitrateKbps} onCommit={(bitrateKbps) => onChange({ bitrateKbps })} />
          </div>
        </FieldRow>
      )}
      <FieldRow label="Encoding">
        <Segmented<EncodeSpeed>
          label="Encoding speed"
          value={value.speed}
          options={[
            { value: 'fast', label: 'Fast', title: 'Quickest render, larger file' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'compact', label: 'Compact', title: 'Slowest render, smallest file' },
          ]}
          onChange={(speed) => onChange({ speed })}
        />
      </FieldRow>
    </div>
  );
}

export function SettingsPanel({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const assets = useLibrary((s) => s.assetsById);
  const showSoundwaves = usePrefs((s) => s.showSoundwaves);
  const showGhostPlayhead = usePrefs((s) => s.showGhostPlayhead);
  const [advancedOpen, setAdvancedOpen] = useState(!!doc.settings.exportAdvanced);
  const s = doc.settings;

  const spec = resolveOutputSpec(doc, assets);
  const adv = effectiveAdvanced(doc);
  const source = sourceResolution(doc, assets);
  const fps = effectiveFps(doc, assets);

  return (
    <div className="panel-body">
      <h2 className="panel-title">Settings</h2>

      <section>
        <h3>Size</h3>
        <SizeSelect />
        <p className="faint panel-note">
          <Scaling size={12} /> {s.width} × {s.height} canvas
        </p>
      </section>

      <section>
        <div className="row">
          <h3 className="grow">Export settings</h3>
          <button type="button" className="link-btn" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
            {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Advanced
          </button>
        </div>
        <select
          className="select"
          aria-label="Export quality"
          value={s.exportAdvanced ? 'custom' : s.exportPresetId}
          onChange={(e) => updateSettings({ exportPresetId: e.target.value, exportAdvanced: null })}
        >
          {s.exportAdvanced && <option value="custom">Custom</option>}
          {(['Quality', 'YouTube'] as const).map((group) => (
            <optgroup key={group} label={group}>
              {EXPORT_PRESETS.filter((p) => p.group === group).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} · {p.description}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {advancedOpen && (
          <AdvancedExport value={adv} onChange={(patch) => updateSettings({ exportAdvanced: { ...(s.exportAdvanced ?? advancedFromPreset(s.exportPresetId, s.fps)), ...patch } })} />
        )}
        <p className="faint panel-note tabular">
          Exports as {spec.width} × {spec.height} · {fps} fps · H.264 MP4 · {spec.rateControl === 'vbr' ? 'variable' : 'constant'} bitrate
        </p>
        {source > 0 && source < adv.resolution && (
          <Notice icon={<Info size={14} />}>
            Your footage is {resolutionLabel(source)}. Exporting at {resolutionLabel(adv.resolution)} makes a larger file but does not add detail.
          </Notice>
        )}
      </section>

      <section>
        <h3>Background</h3>
        <ColorField label="Background colour" value={s.background} onChange={(background) => updateSettings({ background }, 'background')} />
        <div className="swatches">
          {BACKGROUND_SWATCHES.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Background ${c}`} aria-pressed={s.background === c} onClick={() => updateSettings({ background: c })} />
          ))}
        </div>
        <Button size="small" icon={<ImageIcon size={13} />} onClick={() => void pickBackgroundImage(projectId)}>
          Use an image
        </Button>
      </section>

      <section>
        <h3>Duration</h3>
        <Segmented<'auto' | 'fixed'>
          fill
          label="Project duration"
          value={s.durationMode}
          options={[
            { value: 'auto', label: 'Automatic', title: 'Ends with the last element' },
            { value: 'fixed', label: 'Fixed' },
          ]}
          onChange={(durationMode) => updateSettings({ durationMode, fixedDuration: durationMode === 'fixed' ? Math.max(1, contentEnd(doc)) : s.fixedDuration })}
        />
        {s.durationMode === 'fixed' && (
          <FieldRow label="Length">
            <div className="fixed">
              <TimeInput label="Project length" value={s.fixedDuration} onCommit={(fixedDuration) => updateSettings({ fixedDuration: Math.max(0.1, fixedDuration) })} />
            </div>
          </FieldRow>
        )}
      </section>

      <section>
        <h3>Timeline</h3>
        <FieldRow label="Show soundwaves">
          <Switch label="Show soundwaves" checked={showSoundwaves} onChange={(v) => setPrefs({ showSoundwaves: v })} />
        </FieldRow>
        <FieldRow label="Show ghost playhead">
          <Switch label="Show ghost playhead" checked={showGhostPlayhead} onChange={(v) => setPrefs({ showGhostPlayhead: v })} />
        </FieldRow>
      </section>

      <section>
        <h3>Frames per second</h3>
        <select className="select" aria-label="Frames per second" value={s.fps} onChange={(e) => updateSettings({ fps: Number(e.target.value) })}>
          {FPS_OPTIONS.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        {fps < s.fps && <p className="faint panel-note">Your footage runs at {fps} fps, so that is what the export will use.</p>}
      </section>
    </div>
  );
}
