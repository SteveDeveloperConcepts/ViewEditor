// Project commands shared by the dashboard pages: starting projects and the ••• menu of a project card.

import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  LayoutTemplate,
  Pencil,
  Proportions,
  RotateCcw,
  Scissors,
  Trash2,
} from 'lucide-react';
import { fileTitle, SIZE_PRESETS, TRASH_RETENTION_DAYS } from '@shared/constants';
import { canvasForMedia, makeAudioItem, makeImageItem, makeVideoItem, resizeCanvas } from '@shared/timeline';
import { isActive } from '@shared/ai';
import type { Asset, ID, ProjectDoc, ProjectMeta } from '@shared/types';
import type { MenuEntry } from '@/components/Menu';
import { confirmDialog, Modal, promptDialog } from '@/components/Modal';
import { Button, Field } from '@/components/ui';
import { getLibrary } from '@/store/library';
import { navigate, showModal, toast } from '@/store/ui';
import { api, errorMessage } from './api';

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

/** Where a new project goes in the library. */
export interface ProjectPlace {
  spaceId?: ID | null;
  folderId?: ID | null;
}

/** Projects started empty here, with the name they started with. */
const drafts = new Map<ID, string>();

/** A new, empty project, straight into the editor. It goes away again if nothing is ever put in it. */
export function startBlankProject(place: ProjectPlace = {}, name?: string, showAi = false): Promise<void> {
  return attempt(async () => {
    const meta = await api.library.createProject({ ...place, name });
    drafts.set(meta.id, meta.name);
    await navigate({ page: 'editor', projectId: meta.id, showAi });
  });
}

/** Removes a project that was started empty and stayed that way. Called as it closes. */
export async function discardIfUnused(doc: ProjectDoc | null): Promise<void> {
  if (!doc || doc.items.length || drafts.get(doc.id) !== doc.name) return;
  const waiting = getLibrary().aiJobs?.some((j) => isActive(j) && j.request.target.projectId === doc.id);
  if (waiting) return;
  drafts.delete(doc.id);
  await api.library.deleteProjectsForever([doc.id]).catch(() => undefined);
}

/** Starts a project around media that is already in the library, and opens it. */
export async function startProjectWith(assets: Asset[], place: ProjectPlace = {}): Promise<void> {
  if (!assets.length) return;
  const meta = await api.library.createProject({ ...place, name: fileTitle(assets[0].name) });
  await navigate({ page: 'editor', projectId: meta.id, add: assets });
}

/** Starts a project around one piece of media and opens it. */
export async function startProjectWithAsset(asset: Asset, name: string): Promise<void> {
  const meta = await api.library.createProject({ name });
  let doc = await api.library.loadProject(meta.id);
  const track = doc.tracks[0].id;
  if (asset.kind === 'audio') {
    doc = { ...doc, items: [makeAudioItem(asset, track, 0)] };
  } else {
    const size = canvasForMedia(asset.width, asset.height);
    doc = resizeCanvas(doc, size.width, size.height, 'fit');
    doc = { ...doc, settings: { ...doc.settings, autoSize: false }, items: [asset.kind === 'video' ? makeVideoItem(asset, doc, track, 0) : makeImageItem(asset, doc, track, 0)] };
  }
  await api.library.saveProject(doc);
  await navigate({ page: 'editor', projectId: meta.id });
}

function MoveBody({ ids, close }: { ids: ID[]; close: (moved?: boolean) => void }): ReactNode {
  const lib = getLibrary();
  const first = lib.projects.find((p) => p.id === ids[0]);
  const [spaceId, setSpaceId] = useState(first?.spaceId ?? lib.spaces[0].id);
  const [folderId, setFolderId] = useState<ID | ''>(first?.folderId ?? '');
  const folders = lib.folders.filter((f) => f.spaceId === spaceId);

  const options: ReactNode[] = [];
  const addFolders = (parent: ID | null, depth: number): void => {
    for (const f of folders.filter((x) => x.parentId === parent)) {
      options.push(
        <option key={f.id} value={f.id}>
          {'   '.repeat(depth)}
          {f.name}
        </option>,
      );
      addFolders(f.id, depth + 1);
    }
  };
  addFolders(null, 1);

  return (
    <Modal
      title={ids.length === 1 ? 'Move project' : `Move ${ids.length} projects`}
      onClose={() => close()}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              void attempt(async () => {
                await api.library.moveProjects(ids, spaceId, folderId || null);
                close(true);
              });
            }}
          >
            Move
          </Button>
        </>
      }
    >
      {lib.spaces.length > 1 && (
        <Field label="Space">
          <select
            className="select"
            value={spaceId}
            onChange={(e) => {
              setSpaceId(e.target.value);
              setFolderId('');
            }}
          >
            {lib.spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Folder">
        <select className="select" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">No folder</option>
          {options}
        </select>
      </Field>
    </Modal>
  );
}

export function moveProjects(ids: ID[]): Promise<boolean> {
  return showModal<boolean>((close) => <MoveBody ids={ids} close={close} />).then((r) => r === true);
}

export async function trashProjects(ids: ID[]): Promise<void> {
  await attempt(async () => {
    await api.library.trashProjects(ids);
    toast(ids.length === 1 ? 'Project moved to Trash.' : `${ids.length} projects moved to Trash.`, {
      action: { label: 'Undo', run: () => void api.library.restoreProjects(ids) },
    });
  });
}

export async function deleteForever(ids: ID[]): Promise<boolean> {
  const ok = await confirmDialog({
    title: ids.length === 1 ? 'Delete this project permanently?' : `Delete ${ids.length} projects permanently?`,
    message: 'This cannot be undone. The project and its export are removed from this computer. Its media stays in Media.',
    confirmLabel: 'Delete permanently',
    danger: true,
  });
  if (ok) await attempt(() => api.library.deleteProjectsForever(ids));
  return ok;
}

function ResizeBody({ meta, close }: { meta: ProjectMeta; close: () => void }): ReactNode {
  const [presetId, setPresetId] = useState(SIZE_PRESETS.find((p) => p.width / p.height !== meta.width / meta.height)?.id ?? SIZE_PRESETS[1].id);
  const preset = SIZE_PRESETS.find((p) => p.id === presetId)!;
  const create = (): void => {
    void attempt(async () => {
      const doc = await api.library.loadProject(meta.id);
      const short = Math.min(doc.settings.width, doc.settings.height);
      const s = short / Math.min(preset.width, preset.height);
      const resized = resizeCanvas(doc, Math.round((preset.width * s) / 2) * 2, Math.round((preset.height * s) / 2) * 2, 'fill');
      const copy = await api.library.createProject({
        name: `${meta.name} ${preset.id}`,
        spaceId: meta.spaceId,
        folderId: meta.folderId,
        doc: resized,
      });
      close();
      await navigate({ page: 'editor', projectId: copy.id });
    });
  };
  return (
    <Modal
      title="Copy in a new shape"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={create}>
            Create copy
          </Button>
        </>
      }
    >
      <p>This makes a copy of the project in the new shape. The original stays as it is.</p>
      <Field label="New shape">
        <select className="select" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
          {SIZE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {p.hint}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

/** The ••• menu of a project card. */
export function projectMenu(meta: ProjectMeta): MenuEntry[] {
  if (meta.trashedAt) {
    return [
      { label: 'Restore', icon: <RotateCcw size={15} />, onSelect: () => void attempt(() => api.library.restoreProjects([meta.id])) },
      { label: 'Delete permanently', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteForever([meta.id]) },
    ];
  }
  const exported = !!meta.lastExport;
  return [
    { label: 'Edit', icon: <Scissors size={15} />, onSelect: () => void navigate({ page: 'editor', projectId: meta.id }) },
    {
      label: 'Rename',
      icon: <Pencil size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'Rename project', label: 'Name', value: meta.name }).then((name) => {
          if (name) void attempt(() => api.library.renameProject(meta.id, name));
        });
      },
    },
    {
      label: 'Duplicate',
      icon: <Copy size={15} />,
      onSelect: () => {
        void attempt(async () => {
          const copy = await api.library.duplicateProject(meta.id);
          toast(`Created “${copy.name}”.`, { kind: 'success' });
        });
      },
    },
    { label: 'Move', icon: <FolderInput size={15} />, onSelect: () => void moveProjects([meta.id]) },
    {
      label: 'Save as a template',
      icon: <LayoutTemplate size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'Save as a template', label: 'Template name', value: meta.name, confirmLabel: 'Save template' }).then((name) => {
          if (!name) return;
          void attempt(async () => {
            await api.library.saveAsTemplate(meta.id, name);
            toast('Template saved.', { kind: 'success', action: { label: 'View', run: () => void navigate({ page: 'templates' }) } });
          });
        });
      },
    },
    exported && {
      label: 'Copy in a new shape',
      icon: <Proportions size={15} />,
      onSelect: () => void showModal<void>((close) => <ResizeBody meta={meta} close={() => close()} />),
    },
    exported && {
      label: 'Show in folder',
      icon: <FolderOpen size={15} />,
      onSelect: () => void attempt(() => api.render.revealExport(meta.id)),
    },
    {
      label: 'Save video',
      icon: <Download size={15} />,
      onSelect: () => {
        if (exported) void navigate({ page: 'video', projectId: meta.id });
        else {
          toast('This project is still a draft. Export it first, then you can save it.', {
            action: { label: 'Open', run: () => void navigate({ page: 'editor', projectId: meta.id }) },
          });
        }
      },
    },
    null,
    { label: 'Move to Trash', icon: <Trash2 size={15} />, danger: true, onSelect: () => void trashProjects([meta.id]) },
  ];
}

export const TRASH_NOTE = `Projects in Trash are kept for ${TRASH_RETENTION_DAYS} days, then deleted for good.`;
