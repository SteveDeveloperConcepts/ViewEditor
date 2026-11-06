// Editing commands that are reachable from more than one place (toolbar, right-click menu, keyboard).

import { ClipboardPaste, Copy, CopyPlus, Download, Group, Replace, Scissors, Sparkles, Trash2, Ungroup, Volume2, VolumeX } from 'lucide-react';
import { formatClock } from '@shared/time';
import { isTimed, itemEnd } from '@shared/timeline';
import type { ID, Item } from '@shared/types';
import { actionLabel, actionsFor, openClipAi } from '@/ai/clipActions';
import { openConnections } from '@/ai/ConnectionsDialog';
import type { MenuEntry } from '@/components/Menu';
import { api, errorMessage, MOD_LABEL } from '@/lib/api';
import { useAi } from '@/store/ai';
import { startRender } from '@/lib/exporter';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  flushSave,
  groupSelection,
  hasClipboard,
  paste,
  replaceMedia,
  selectedItems,
  selectionHasGroup,
  splitAtPlayhead,
  ungroupSelection,
  updateItem,
  useEditor,
} from '@/store/editor';
import { toast } from '@/store/ui';
import { reportRejected } from './importing';

/** The stretch of timeline covered by the selected elements. */
export function selectionRange(): { start: number; end: number } | null {
  const items = selectedItems();
  if (!items.length) return null;
  return { start: Math.min(...items.map((it) => it.start)), end: Math.max(...items.map(itemEnd)) };
}

/** Renders only the part of the project between the start and end of the selection, and saves it as an MP4. */
export async function downloadSection(): Promise<void> {
  const doc = useEditor.getState().doc;
  const range = selectionRange();
  if (!doc || !range) return;
  try {
    await flushSave();
    const label = `${formatClock(range.start)}-${formatClock(range.end)}`.replace(/:/g, '.');
    await startRender(doc, { kind: 'section', window: range, suggestedName: `${doc.name} ${label}` });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

export async function replaceMediaFor(item: Item, projectId: ID): Promise<void> {
  if (item.type === 'text') return;
  try {
    const result = await api.assets.pickAndImport(item.type === 'audio' ? 'audio' : 'media', { scope: 'project', projectId });
    if (!result) return;
    reportRejected(result);
    const wanted = result.assets.find((a) => (a.kind === 'audio') === (item.type === 'audio'));
    if (wanted) replaceMedia(item.id, wanted);
    else if (result.assets.length) toast(item.type === 'audio' ? 'Choose an audio file to replace audio.' : 'Choose a video or an image to replace this clip.', { kind: 'error' });
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
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
    item.type !== 'text' && !many && { label: 'Replace media…', icon: <Replace size={15} />, onSelect: () => void replaceMediaFor(item, projectId) },
    range && {
      label: `Export section (${formatClock(range.start)} – ${formatClock(range.end)})`,
      icon: <Download size={15} />,
      onSelect: () => void downloadSection(),
    },
    isTimed(item) &&
      !many && {
        label: item.muted ? 'Unmute' : 'Mute',
        icon: item.muted ? <Volume2 size={15} /> : <VolumeX size={15} />,
        onSelect: () => updateItem(item.id, { muted: !item.muted }),
      },
    !many && actionsFor(item).length > 0 && null,
    ...(many ? [] : actionsFor(item)).map((action) => ({
      label: actionLabel(action),
      icon: <Sparkles size={15} />,
      onSelect: () => (useAi.getState().providers.some((p) => p.connected) ? openClipAi(item, action, projectId) : openConnections()),
    })),
    (many || selectionHasGroup(doc, s.selection)) && null,
    many && { label: 'Group', icon: <Group size={15} />, hint: `${MOD_LABEL}+G`, onSelect: groupSelection },
    selectionHasGroup(doc, s.selection) && { label: 'Ungroup', icon: <Ungroup size={15} />, onSelect: ungroupSelection },
    null,
    { label: 'Delete', icon: <Trash2 size={15} />, hint: 'Del', danger: true, onSelect: deleteSelection },
  ];
}
