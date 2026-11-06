// Getting files into the open project: from the file picker, from a drop, or from a recording.

import type { PickKind } from '@shared/api';
import { ALL_MEDIA_EXTS, extOf } from '@shared/constants';
import type { Asset, ID, ImportResult } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { addAsset, type Placement } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/ui';

/** Drag type used when an asset tile is dragged from a panel onto the timeline. */
export const ASSET_DRAG_TYPE = 'application/x-vieweditor-asset';

export function reportRejected(result: ImportResult): void {
  if (!result.rejected.length) return;
  const first = result.rejected[0];
  const more = result.rejected.length > 1 ? ` (and ${result.rejected.length - 1} more)` : '';
  toast(`${first.name} was not added: ${first.reason}${more}`, { kind: 'error' });
}

/** Paths of the files in a drop, or an empty list when the drop carries no files. */
export function droppedPaths(data: DataTransfer | null): string[] {
  if (!data) return [];
  return [...data.files].map((f) => api.pathForFile(f)).filter(Boolean);
}

export function hasFiles(data: DataTransfer | null): boolean {
  return !!data && [...data.types].includes('Files');
}

/**
 * Makes new assets known to the page at once. The library update that carries them arrives a moment
 * after the import call returns, and until then the timeline would show them as missing.
 */
function rememberAssets(assets: Asset[]): void {
  useLibrary.setState((s) => ({ assetsById: { ...s.assetsById, ...Object.fromEntries(assets.map((a) => [a.id, a])) } }));
}

/** Waits for an asset to reach some state. If that never happens, the last known version is used. */
function waitForAsset(asset: Asset, ready: (a: Asset) => boolean, timeoutMs = 8000): Promise<Asset> {
  const current = (): Asset => useLibrary.getState().assetsById[asset.id] ?? asset;
  return new Promise((resolve) => {
    if (ready(current())) {
      resolve(current());
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(current());
    }, timeoutMs);
    const unsubscribe = useLibrary.subscribe(() => {
      if (!ready(current())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(current());
    });
  });
}

/** Puts freshly imported assets on the timeline, in the order they were chosen. */
export async function addToTimeline(assets: Asset[], where?: Placement): Promise<void> {
  rememberAssets(assets);
  for (const asset of assets) {
    // Images get their true size a moment after import.
    addAsset(asset.kind === 'image' ? await waitForAsset(asset, (a) => a.hasThumb) : asset, where);
    // Only the first clip takes the explicit position; the rest follow the normal rules.
    where = undefined;
  }
}

async function finish(result: ImportResult | null, add: boolean, where?: Placement): Promise<Asset[]> {
  if (!result) return [];
  reportRejected(result);
  if (add) await addToTimeline(result.assets, where);
  return result.assets;
}

export async function pickIntoProject(kind: PickKind, projectId: ID, add = true): Promise<Asset[]> {
  try {
    return await finish(await api.assets.pickAndImport(kind, { scope: 'project', projectId }), add);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
    return [];
  }
}

/** The "add media" shortcut: any kind of file, straight onto the timeline. */
export function pickIntoProjectAny(projectId: ID): Promise<Asset[]> {
  return pickIntoProject('media', projectId);
}

export async function importPathsIntoProject(paths: string[], projectId: ID, add = true, where?: Placement): Promise<Asset[]> {
  if (!paths.length) return [];
  try {
    return await finish(await api.assets.importPaths(paths, { scope: 'project', projectId }), add, where);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
    return [];
  }
}

/** Human-readable list for "supported formats" hints. */
export const SUPPORTED_SUMMARY = 'MP4, MOV, MKV, WEBM, AVI, GIF and more · MP3, WAV, M4A, FLAC, OGG · JPG, PNG, WEBP, AVIF';

export function looksSupported(name: string): boolean {
  return ALL_MEDIA_EXTS.includes(extOf(name));
}
