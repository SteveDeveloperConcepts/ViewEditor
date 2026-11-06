// Export: what to make, how good, and how much of the project, all decided before anything renders.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Info, Share } from 'lucide-react';
import { EXPORT_PRESETS, RESOLUTION_OPTIONS, advancedFromPreset, defaultBitrate, resolutionLabel } from '@shared/constants';
import { effectiveAdvanced, effectiveFps, fullWindow, resolveOutputSpec, sourceResolution, type ExportFormat } from '@shared/render';
import { formatClock } from '@shared/time';
import { contentEnd } from '@shared/timeline';
import type { EncodeSpeed, ExportAdvanced, ID, RateControl } from '@shared/types';
import { Modal } from '@/components/Modal';
import { Button, Field, FieldRow, Notice, NumberInput, Segmented, Slider, Spinner, TimeInput } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { startRender } from '@/lib/exporter';
import { updateSettings, useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { navigate, showModal } from '@/store/ui';
import { selectionRange } from './actions';
import { saveAndThumbnail } from './save';

type Part = 'all' | 'selection' | 'custom';

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
            { value: 'fast', label: 'Fast', title: 'Quickest export, larger file' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'compact', label: 'Compact', title: 'Slowest export, smallest file' },
          ]}
          onChange={(speed) => onChange({ speed })}
        />
      </FieldRow>
    </div>
  );
}

function ExportBody({ projectId, part: asked, close }: { projectId: ID; part: Part; close: () => void }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const assets = useLibrary((s) => s.assetsById);
  const [selected] = useState(selectionRange);
  const [format, setFormat] = useState<ExportFormat>('mp4');
  const [part, setPart] = useState<Part>(asked === 'selection' && !selected ? 'all' : asked);
  const [custom, setCustom] = useState(selected ?? fullWindow(doc));
  const [advancedOpen, setAdvancedOpen] = useState(!!doc.settings.exportAdvanced);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const s = doc.settings;
  const spec = resolveOutputSpec(doc, assets);
  const adv = effectiveAdvanced(doc);
  const source = sourceResolution(doc, assets);
  const fps = effectiveFps(doc, assets);
  const window = part === 'all' ? fullWindow(doc) : part === 'selection' && selected ? selected : custom;
  const seconds = Math.max(0, window.end - window.start);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await saveAndThumbnail();
      const current = useEditor.getState().doc;
      if (!current) return;
      if (format === 'mp4' && part === 'all') {
        await startRender(current, { kind: 'export' });
        close();
        await navigate({ page: 'video', projectId });
      } else {
        const piece = part === 'all' ? '' : ` ${formatClock(window.start)}-${formatClock(window.end)}`.replace(/:/g, '.');
        const started = await startRender(current, { kind: 'section', window, format, suggestedName: `${current.name}${piece}` });
        if (started) close();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Export"
      size="wide"
      onClose={close}
      dismissable={!busy}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={busy ? <Spinner /> : <Share size={15} />} disabled={busy || seconds <= 0} onClick={() => void run()}>
            Export
          </Button>
        </>
      }
    >
      <Field label="Make a">
        <Segmented<ExportFormat>
          fill
          label="Format"
          value={format}
          options={[
            { value: 'mp4', label: 'Video (MP4)' },
            { value: 'mp3', label: 'Sound only (MP3)' },
            { value: 'gif', label: 'GIF' },
          ]}
          onChange={setFormat}
        />
      </Field>
      <Field label="From">
        <Segmented<Part>
          fill
          label="How much of the project"
          value={part}
          options={[
            { value: 'all', label: `The whole project (${formatClock(fullWindow(doc).end)})` },
            ...(selected ? [{ value: 'selection' as const, label: `Selected clips (${formatClock(selected.start)} – ${formatClock(selected.end)})` }] : []),
            { value: 'custom', label: 'A stretch of time' },
          ]}
          onChange={setPart}
        />
      </Field>
      {part === 'custom' && (
        <div className="form-grid">
          <label className="field">
            <span className="label">Start</span>
            <TimeInput label="Export from" value={custom.start} onCommit={(t) => setCustom((c) => ({ ...c, start: Math.max(0, Math.min(t, c.end)) }))} />
          </label>
          <label className="field">
            <span className="label">End</span>
            <TimeInput label="Export up to" value={custom.end} onCommit={(t) => setCustom((c) => ({ ...c, end: Math.min(contentEnd(doc), Math.max(t, c.start)) }))} />
          </label>
        </div>
      )}
      {format === 'mp4' && (
        <div className="field">
          <div className="row">
            <span className="label grow">Quality</span>
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
          {source > 0 && source < adv.resolution && (
            <Notice icon={<Info size={14} />}>
              Your footage is {resolutionLabel(source)}. Exporting at {resolutionLabel(adv.resolution)} makes a larger file but does not add detail.
            </Notice>
          )}
        </div>
      )}
      <p className="faint tabular">
        {format === 'mp3' ? 'MP3 sound' : format === 'gif' ? 'A small, silent, looping GIF' : `${spec.width} × ${spec.height} · ${fps} fps · H.264 MP4`} · {formatClock(seconds)}
        {format === 'mp4' && part === 'all' ? '. It opens in a preview, ready to save.' : '. You choose where to save it next.'}
      </p>
      {error && <Notice kind="error" icon={<Info size={14} />}>{error}</Notice>}
    </Modal>
  );
}

export function openExportDialog(projectId: ID, part: Part = 'all'): void {
  void showModal<void>((close) => <ExportBody projectId={projectId} part={part} close={() => close()} />);
}
