import { updateProjectThumb } from '@/lib/thumbnail';
import { flushSave, useEditor } from '@/store/editor';
import { pause } from './player';

/** Saves the project and refreshes its picture on the dashboard. */
export async function saveAndThumbnail(): Promise<void> {
  const doc = useEditor.getState().doc;
  if (!doc) return;
  pause();
  await flushSave();
  await updateProjectThumb(doc).catch(() => undefined);
}
