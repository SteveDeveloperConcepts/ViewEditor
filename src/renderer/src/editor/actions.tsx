// Editing commands that are reachable from more than one place (toolbar, right-click menu, keyboard).

import { AudioLines, ClipboardPaste, Copy, CopyPlus, Download, Group, Replace, Scissors, Sparkles, Trash2, Undo2, Ungroup, Volume2, VolumeX } from 'lucide-react';
import { formatClock } from '@shared/time';
import { detachAudio, isTimed, itemEnd, updateItems } from '@shared/timeline';
import type { Asset, ID, Item } from '@shared/types';
import { actionLabel, actionsFor, openClipAi } from '@/ai/clipActions';
import { openConnections } from '@/ai/ConnectionsDialog';
import type { MenuEntry } from '@/components/Menu';
import { confirmDialog } from '@/components/Modal';
import { api, errorMessage, MOD_LABEL } from '@/lib/api';
import { useAi } from '@/store/ai';
import {
  addAsset,
  apply,
  copySelection,
  deleteSelection,
  duplicateSelection,
  groupSelection,
  hasClipboard,
  paste,
  replaceMedia,
  restoreOriginal,
  select,
  selectedItems,
  selectionHasGroup,
  splitAtPlayhead,
  ungroupSelection,
  updateItem,
  useEditor,
} from '@/store/editor';
import { getAssets } from '@/store/library';
import { toast } from '@/store/ui';
import { openExportDialog } from './ExportDialog';
import { rememberAssets } from './importing';
import { pickFromMedia } from './MediaPicker';

/** The stretch of timeline covered by the selected elements. */
export function selectionRange(): { start: number; end: number } | null {
  const items = selectedItems();
  if (!items.length) return null;
  return { start: Math.min(...items.map((it) => it.start)), end: Math.max(...items.map(itemEnd)) };
}

export async function replaceMediaFor(item: Item): Promise<void> {
  if (item.type === 'text') return;
  const audio = item.type === 'audio';
  const chosen = await pickFromMedia({ title: 'Replace media', kinds: audio ? ['audio'] : ['video', 'image'], files: audio ? 'audio' : 'media', exclude: item.assetId });
  if (chosen) replaceMedia(item.id, chosen);
}

/** Pulls a clip's sound out: it becomes its own clip, lined up underneath, and the video is muted. */
export async function extractAudioFrom(item: Item): Promise<void> {
  if (item.type !== 'video') return;
  try {
    const sound = await api.assets.extractAudio(item.assetId);
    rememberAssets([sound]);
    let audioId: ID | null = null;
    apply((doc) => {
      const result = detachAudio(doc, item.id, sound);
      if (!result) return doc;
      audioId = result.audioId;
      return result.doc;
    });
    if (!audioId) return;
    select([audioId], { inspect: false });
    toast('The sound is now its own clip, and the video is muted.', { kind: 'success' });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

/** Takes the sound of a video in Media and puts it on the timeline at the playhead. */
export async function addSoundOf(video: Asset): Promise<void> {
  try {
    const sound = await api.assets.extractAudio(video.id);
    rememberAssets([sound]);
    addAsset(sound);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

/** A voice-over competes with any sound still playing under it, so the question is asked once it lands. */
export async function offerToMuteUnder(voiceId: ID | undefined): Promise<void> {
  const doc = useEditor.getState().doc;
  const voice = doc?.items.find((it) => it.id === voiceId);
  if (!doc || !voice) return;
  const assets = getAssets();
  const under = doc.items.filter((it) => it.type === 'video' && !it.muted && it.volume > 0 && assets[it.assetId]?.hasAudio && it.start < itemEnd(voice) && itemEnd(it) > voice.start);
  if (!under.length) return;
  const mute = await confirmDialog({
    title: 'Mute the sound underneath?',
    message: 'Your video has its own sound while this voice-over plays. Mute the video so only the voice-over is heard?',
    confirmLabel: 'Mute the video',
    cancelLabel: 'Keep both',
  });
  if (mute) apply((d) => updateItems(d, under.map((it) => it.id), (it) => ({ ...it, muted: true }) as Item));
}

/** Right-click menu of a timeline element. */
export function itemMenu(item: Item, projectId: ID): MenuEntry[] {
  const s = useEditor.getState();
  const doc = s.doc!;
  const inside = s.playhead > item.start + 1e-3 && s.playhead < itemEnd(item) - 1e-3;
  const many = s.selection.length > 1;
  const range = selectionRange();
  return [
    { label: 'Split clip', icon: <Scissors size={15} />, hint: 'S', disabled: !inside, onSelect: () => void splitAtPlayhead() },
    null,
    { label: 'Copy', icon: <Copy size={15} />, hint: `${MOD_LABEL}+C`, onSelect: () => void copySelection() },
    { label: 'Paste', icon: <ClipboardPaste size={15} />, hint: `${MOD_LABEL}+V`, disabled: !hasClipboard(), onSelect: () => paste() },
    { label: 'Duplicate', icon: <CopyPlus size={15} />, hint: `${MOD_LABEL}+D`, onSelect: duplicateSelection },
    item.type !== 'text' && !many && { label: 'Replace media…', icon: <Replace size={15} />, onSelect: () => void replaceMediaFor(item) },
    range && {
      label: `Export section (${formatClock(range.start)} – ${formatClock(range.end)})`,
      icon: <Download size={15} />,
      onSelect: () => openExportDialog(projectId, 'selection'),
    },
    isTimed(item) &&
      !many && {
        label: item.muted ? 'Unmute' : 'Mute',
        icon: item.muted ? <Volume2 size={15} /> : <VolumeX size={15} />,
        onSelect: () => updateItem(item.id, { muted: !item.muted }),
      },
    item.type === 'video' &&
      !many &&
      getAssets()[item.assetId]?.hasAudio && { label: 'Extract audio', icon: <AudioLines size={15} />, onSelect: () => void extractAudioFrom(item) },
    !many && actionsFor(item).length > 0 && null,
    !many && (item.type === 'video' || item.type === 'image') && item.restore && { label: 'Restore original', icon: <Undo2 size={15} />, onSelect: () => restoreOriginal(item.id) },
    ...(many ? [] : actionsFor(item)).map((action) => ({
      label: actionLabel(action),
      icon: <Sparkles size={15} />,
      onSelect: () => (useAi.getState().providers.some((p) => p.connected) ? openClipAi(item, action) : openConnections()),
    })),
    (many || selectionHasGroup(doc, s.selection)) && null,
    many && { label: 'Group', icon: <Group size={15} />, hint: `${MOD_LABEL}+G`, onSelect: groupSelection },
    selectionHasGroup(doc, s.selection) && { label: 'Ungroup', icon: <Ungroup size={15} />, onSelect: ungroupSelection },
    null,
    { label: 'Delete', icon: <Trash2 size={15} />, hint: 'Del', danger: true, onSelect: deleteSelection },
  ];
}
