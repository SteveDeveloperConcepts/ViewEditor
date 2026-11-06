// What can be done with something in Media, wherever it is shown: previewing it, using it, taking its sound.

import type { ReactNode } from 'react';
import { AudioLines, Eye, Plus, Scissors, Sparkles, Trash2 } from 'lucide-react';
import { fileTitle } from '@shared/constants';
import { formatBytes, formatClock } from '@shared/time';
import type { Asset } from '@shared/types';
import { closeClipAi } from '@/ai/clipActions';
import { draftForSound } from '@/ai/drafts';
import type { MenuEntry } from '@/components/Menu';
import { confirmDialog, Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { addSoundOf } from '@/editor/actions';
import { addAsset, setPanel, useEditor } from '@/store/editor';
import { getLibrary } from '@/store/library';
import { navigate, showModal, toast } from '@/store/ui';
import { api, errorMessage } from './api';
import { assetUrl } from './media';
import { createDraft, startProjectWith } from './projects';

export interface MediaAction {
  label: string;
  icon: ReactNode;
  run: () => void;
  danger?: boolean;
}

async function removeAsset(asset: Asset): Promise<void> {
  try {
    const usage = (await api.assets.usage())[asset.id] ?? 0;
    const ok = await confirmDialog({
      title: `Delete “${asset.name}”?`,
      message: usage
        ? `This file is used in ${usage} project${usage === 1 ? '' : 's'}. Deleting it leaves a “media missing” gap there.`
        : 'The file is removed from Media. The original on your computer is not touched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await api.assets.remove([asset.id]);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

async function extractToMedia(asset: Asset): Promise<void> {
  try {
    const sound = await api.assets.extractAudio(asset.id);
    toast(`The sound is in Media as ${sound.name}.`, { kind: 'success' });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

/** Opens the AI form with this sound chosen and the length to match. */
export async function generatePictureFor(asset: Asset, start = 0, seconds = Math.min(5, asset.duration)): Promise<void> {
  try {
    closeClipAi();
    const open = useEditor.getState().doc;
    const projectId = open?.id ?? (await createDraft()).id;
    draftForSound(projectId, { assetId: asset.id, start }, seconds);
    if (open) setPanel('ai');
    else await navigate({ page: 'editor', projectId, showAi: true });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

/** The project you were last working on, which is where something from Media most likely belongs. */
function lastProject(): { id: string; name: string } | undefined {
  return getLibrary()
    .projects.filter((p) => !p.trashedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Using an item, as opposed to looking at it or deleting it. */
function waysToUse(asset: Asset): MediaAction[] {
  const open = !!useEditor.getState().doc;
  const recent = open ? undefined : lastProject();
  const actions: MediaAction[] = [];
  if (open) actions.push({ label: 'Add at the playhead', icon: <Plus size={15} />, run: () => void addAsset(asset, { atPlayhead: true }) });
  if (recent) actions.push({ label: `Use in “${recent.name}”`, icon: <Plus size={15} />, run: () => void navigate({ page: 'editor', projectId: recent.id, add: [asset] }) });
  if (!open) {
    actions.push({
      label: 'Start a project',
      icon: <Scissors size={15} />,
      run: () => void startProjectWith([asset]).catch((err) => toast(errorMessage(err), { kind: 'error' })),
    });
  }
  if (asset.kind === 'video' && asset.hasAudio) {
    actions.push({ label: 'Extract audio', icon: <AudioLines size={15} />, run: () => void (open ? addSoundOf(asset) : extractToMedia(asset)) });
  }
  if (asset.hasAudio) actions.push({ label: 'Generate a picture for this', icon: <Sparkles size={15} />, run: () => void generatePictureFor(asset) });
  return actions;
}

function details(asset: Asset): string {
  const size = asset.kind === 'audio' ? 'Audio' : `${asset.width} × ${asset.height}`;
  return [size, asset.kind === 'image' ? null : formatClock(asset.duration), formatBytes(asset.size)].filter(Boolean).join(' · ');
}

function PreviewBody({ asset, close }: { asset: Asset; close: () => void }): ReactNode {
  const then = (run: () => void) => () => {
    close();
    run();
  };
  return (
    <Modal
      title={fileTitle(asset.name)}
      size="wide"
      onClose={close}
      footer={waysToUse(asset).map((a, i) => (
        <Button key={a.label} variant={i === 0 ? 'primary' : 'default'} icon={a.icon} onClick={then(a.run)}>
          {a.label}
        </Button>
      ))}
    >
      <div className="preview-stage">
        {asset.kind === 'image' ? (
          <img src={assetUrl(asset, 'original')} alt="" draggable={false} />
        ) : asset.kind === 'video' ? (
          <video src={assetUrl(asset, 'preview')} controls autoPlay playsInline />
        ) : (
          <div className="preview-sound">
            {asset.hasWave && <img src={assetUrl(asset, 'wave')} alt="" draggable={false} />}
            <audio src={assetUrl(asset, 'preview')} controls autoPlay />
          </div>
        )}
      </div>
      <p className="faint tabular">{details(asset)}</p>
      {asset.origin?.prompt && (
        <p className="faint selectable">
          Generated by {asset.origin.model}: {asset.origin.prompt}
        </p>
      )}
    </Modal>
  );
}

export function openPreview(asset: Asset): void {
  void showModal<void>((close) => <PreviewBody asset={asset} close={() => close()} />);
}

/** The menu of an item in Media. */
export function mediaMenu(asset: Asset): MenuEntry[] {
  return [
    { label: 'Preview', icon: <Eye size={15} />, onSelect: () => openPreview(asset) },
    ...waysToUse(asset).map((a) => ({ label: a.label, icon: a.icon, onSelect: a.run })),
    null,
    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => void removeAsset(asset) },
  ];
}
