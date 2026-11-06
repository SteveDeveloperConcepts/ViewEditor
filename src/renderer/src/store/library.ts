import { create } from 'zustand';
import type { AppInfo } from '@shared/api';
import type { Asset, ID, Library, RenderProgress } from '@shared/types';
import { api } from '@/lib/api';
import { useUi } from './ui';

interface LibraryState {
  lib: Library | null;
  info: AppInfo | null;
  assetsById: Record<ID, Asset>;
  /** Progress of an import that is copying files in, or null. */
  importing: { done: number; total: number; name: string } | null;
  /** The export that is running or just finished. */
  render: RenderProgress | null;
}

export const useLibrary = create<LibraryState>(() => ({
  lib: null,
  info: null,
  assetsById: {},
  importing: null,
  render: null,
}));

function setLibrary(lib: Library): void {
  const assetsById: Record<ID, Asset> = {};
  for (const a of lib.assets) assetsById[a.id] = a;
  useLibrary.setState({ lib, assetsById });
}

/** Loads the library and keeps it in step with the main process. */
export async function initLibrary(): Promise<void> {
  api.on('library:changed', setLibrary);
  api.on('assets:importing', (importing) => useLibrary.setState({ importing }));
  api.on('render:progress', (render) => useLibrary.setState({ render }));
  const [info, lib, render] = await Promise.all([api.app.info(), api.library.get(), api.render.current()]);
  // People with work land on it. The start page is for the first run.
  if (lib.projects.some((p) => !p.trashedAt)) useUi.setState({ route: { page: 'library', view: { kind: 'all' } } });
  setLibrary(lib);
  useLibrary.setState({ info, render });
}

export function getLibrary(): Library {
  const lib = useLibrary.getState().lib;
  if (!lib) throw new Error('The library is not loaded yet.');
  return lib;
}

export function getAssets(): Record<ID, Asset> {
  return useLibrary.getState().assetsById;
}

/** True while an export or a section is rendering. */
export function renderActive(render: RenderProgress | null): boolean {
  return !!render && ['preparing', 'rendering', 'finishing'].includes(render.state);
}

/** True while an export of this project is in progress. */
export function isRendering(render: RenderProgress | null, projectId: ID): boolean {
  return !!render && renderActive(render) && render.projectId === projectId && render.kind === 'export';
}
