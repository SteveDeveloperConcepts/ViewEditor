// Project settings: shape, background, length, timeline view and frame rate. Export has its own dialog.

import type { ReactNode } from 'react';
import { Image as ImageIcon, Scaling } from 'lucide-react';
import { BACKGROUND_SWATCHES, FPS_OPTIONS, SIZE_PRESETS, aspectLabel } from '@shared/constants';
import { effectiveFps } from '@shared/render';
import { contentEnd } from '@shared/timeline';
import type { ID } from '@shared/types';
import { Modal } from '@/components/Modal';
import { ColorField, FieldRow, Segmented, Switch, TimeInput, Button } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { addAsset, fitItem, setCanvasSize, updateItem, updateSettings, useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { setPrefs, usePrefs } from '@/store/prefs';
import { showModal, toast } from '@/store/ui';
import { reportRejected } from './importing';

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

export function SizeSelect({ label = 'Shape', compact = false }: { label?: string; compact?: boolean }): ReactNode {
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

function SettingsBody({ projectId, close }: { projectId: ID; close: () => void }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const assets = useLibrary((s) => s.assetsById);
  const showSoundwaves = usePrefs((s) => s.showSoundwaves);
  const showGhostPlayhead = usePrefs((s) => s.showGhostPlayhead);
  const s = doc.settings;
  const fps = effectiveFps(doc, assets);

  return (
    <Modal title="Project settings" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      <div className="settings-list">
      <section>
        <h3>Shape</h3>
        <SizeSelect />
        <p className="faint panel-note">
          <Scaling size={12} /> {s.width} × {s.height} frame
        </p>
      </section>

      <section>
        <h3>Background</h3>
        <ColorField label="Background colour" value={s.background} onChange={(background) => updateSettings({ background }, 'background')} />
        <div className="swatches">
          {BACKGROUND_SWATCHES.map((c) => (
            <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Background ${c}`} aria-pressed={s.background === c} onClick={() => updateSettings({ background: c })} />
          ))}
        </div>
        <Button
          size="small"
          icon={<ImageIcon size={13} />}
          onClick={() => {
            close();
            void pickBackgroundImage(projectId);
          }}
        >
          Use an image
        </Button>
      </section>

      <section>
        <h3>Length</h3>
        <Segmented<'auto' | 'fixed'>
          fill
          label="How the length is set"
          value={s.durationMode}
          options={[
            { value: 'auto', label: 'Automatic', title: 'Ends with the last clip' },
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
    </Modal>
  );
}

export function openProjectSettings(projectId: ID): void {
  void showModal<void>((close) => <SettingsBody projectId={projectId} close={() => close()} />);
}
