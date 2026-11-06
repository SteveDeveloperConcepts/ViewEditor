// The Project Library: every project, by Space and folder, plus Trash.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Ellipsis,
  Film,
  Folder as FolderIcon,
  FolderInput,
  FolderPlus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { TRASH_RETENTION_MS } from '@shared/constants';
import { formatClock, formatRelative } from '@shared/time';
import type { Folder, ID, ProjectMeta, Space } from '@shared/types';
import { openContextMenu, openMenuAt, type MenuEntry } from '@/components/Menu';
import { confirmDialog, promptDialog } from '@/components/Modal';
import { Button, EmptyState, IconButton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { projectThumbUrl } from '@/lib/media';
import { deleteForever, moveProjects, projectMenu, TRASH_NOTE, trashProjects } from '@/lib/projects';
import { openStartDialog } from '@/lib/startDialog';
import { useLibrary } from '@/store/library';
import { navigate, toast, type LibraryView } from '@/store/ui';

function goTo(view: LibraryView): void {
  void navigate({ page: 'library', view });
}

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function daysLeft(meta: ProjectMeta): number {
  return Math.max(0, Math.ceil(((meta.trashedAt ?? 0) + TRASH_RETENTION_MS - Date.now()) / 86400000));
}

function ProjectCard({ meta, selected, onToggle, showSelection }: { meta: ProjectMeta; selected: boolean; onToggle: () => void; showSelection: boolean }): ReactNode {
  const thumb = projectThumbUrl(meta);
  const open = (): void => {
    if (!meta.trashedAt) void navigate({ page: 'editor', projectId: meta.id });
  };
  return (
    <article className={`project-card${selected ? ' selected' : ''}${showSelection ? ' selecting' : ''}`} onContextMenu={(e) => openContextMenu(e, projectMenu(meta))}>
      <button type="button" className="project-thumb" aria-label={`Open ${meta.name}`} disabled={!!meta.trashedAt} onClick={showSelection ? onToggle : open}>
        {thumb ? <img src={thumb} alt="" draggable={false} loading="lazy" /> : <Film size={26} />}
        {meta.duration > 0 && <span className="badge dark tabular project-duration">{formatClock(meta.duration)}</span>}
        {meta.lastExport && !meta.trashedAt && <span className={`badge project-state ${meta.editedSinceExport ? 'warning' : 'success'}`}>{meta.editedSinceExport ? 'Edited' : 'Exported'}</span>}
      </button>
      <button type="button" className="project-check" role="checkbox" aria-checked={selected} aria-label={`Select ${meta.name}`} onClick={onToggle}>
        {selected && <Check size={13} />}
      </button>
      <div className="project-meta">
        <div className="grow">
          <div className="project-name-label truncate" title={meta.name}>
            {meta.name}
          </div>
          <div className="faint">{meta.trashedAt ? `Deleted in ${daysLeft(meta)} day${daysLeft(meta) === 1 ? '' : 's'}` : `Edited ${formatRelative(meta.updatedAt)}`}</div>
        </div>
        <IconButton small label={`More options for ${meta.name}`} onClick={(e) => openMenuAt(e.currentTarget, projectMenu(meta), 'end')}>
          <Ellipsis size={16} />
        </IconButton>
      </div>
    </article>
  );
}

function spaceMenu(space: Space, folderId: ID | null): MenuEntry[] {
  return [
    {
      label: 'New folder',
      icon: <FolderPlus size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'New folder', label: 'Folder name', confirmLabel: 'Create' }).then((name) => {
          if (name) void attempt(() => api.library.createFolder(space.id, folderId, name));
        });
      },
    },
    {
      label: 'Rename space',
      icon: <Pencil size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'Rename space', label: 'Name', value: space.name }).then((name) => {
          if (name) void attempt(() => api.library.renameSpace(space.id, name));
        });
      },
    },
    !space.isDefault && null,
    !space.isDefault && {
      label: 'Delete space',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () => {
        void confirmDialog({
          title: `Delete “${space.name}”?`,
          message: 'Its folders are removed. The projects inside are kept and move to your default space.',
          confirmLabel: 'Delete space',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          void attempt(async () => {
            await api.library.deleteSpace(space.id);
            goTo({ kind: 'all' });
          });
        });
      },
    },
  ];
}

function folderMenu(folder: Folder): MenuEntry[] {
  return [
    {
      label: 'Rename',
      icon: <Pencil size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'Rename folder', label: 'Name', value: folder.name }).then((name) => {
          if (name) void attempt(() => api.library.renameFolder(folder.id, name));
        });
      },
    },
    {
      label: 'Delete folder',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () => {
        void confirmDialog({
          title: `Delete “${folder.name}”?`,
          message: 'Subfolders go with it. The projects inside are kept and move up one level.',
          confirmLabel: 'Delete folder',
          danger: true,
        }).then((ok) => {
          if (ok) void attempt(() => api.library.deleteFolder(folder.id));
        });
      },
    },
  ];
}

export function LibraryPage({ view }: { view: LibraryView }): ReactNode {
  const lib = useLibrary((s) => s.lib)!;
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<ID>>(new Set());

  const space = view.kind === 'space' ? lib.spaces.find((s) => s.id === view.spaceId) : undefined;
  const folderId = view.kind === 'space' ? view.folderId : null;
  const folder = lib.folders.find((f) => f.id === folderId);

  const projects = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lib.projects
      .filter((p) => {
        if (view.kind === 'trash') return !!p.trashedAt;
        if (p.trashedAt) return false;
        if (view.kind === 'space' && p.spaceId !== view.spaceId) return false;
        if (view.kind === 'space' && !q && (p.folderId ?? null) !== view.folderId) return false;
        return true;
      })
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => (view.kind === 'trash' ? (b.trashedAt ?? 0) - (a.trashedAt ?? 0) : b.updatedAt - a.updatedAt));
  }, [lib.projects, view, query]);

  const folders = view.kind === 'space' && !query ? lib.folders.filter((f) => f.spaceId === view.spaceId && (f.parentId ?? null) === folderId) : [];
  const live = new Set(projects.map((p) => p.id));
  const selected = [...picked].filter((id) => live.has(id));
  const title = view.kind === 'trash' ? 'Trash' : view.kind === 'all' ? 'All Spaces' : (space?.name ?? 'Space');

  const toggle = (id: ID): void => {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clear = (): void => setPicked(new Set());

  const openSwitcher = (el: Element): void => {
    openMenuAt(el, [
      { label: 'All Spaces', checked: view.kind === 'all', onSelect: () => goTo({ kind: 'all' }) },
      null,
      ...lib.spaces.map((s) => ({
        label: s.name,
        checked: view.kind === 'space' && view.spaceId === s.id,
        onSelect: () => goTo({ kind: 'space', spaceId: s.id, folderId: null }),
      })),
      {
        label: 'New space…',
        icon: <Plus size={15} />,
        onSelect: () => {
          void promptDialog({ title: 'New space', label: 'Space name', confirmLabel: 'Create', placeholder: 'Marketing' }).then((name) => {
            if (!name) return;
            void attempt(async () => {
              const created = await api.library.createSpace(name);
              goTo({ kind: 'space', spaceId: created.id, folderId: null });
            });
          });
        },
      },
      null,
      { label: 'Trash', icon: <Trash2 size={15} />, checked: view.kind === 'trash', onSelect: () => goTo({ kind: 'trash' }) },
    ]);
  };

  const crumbs: Folder[] = [];
  for (let f = folder; f; f = lib.folders.find((x) => x.id === f!.parentId)) crumbs.unshift(f);

  return (
    <div className="page">
      <header className="page-head">
        <button type="button" className="space-switcher" onClick={(e) => openSwitcher(e.currentTarget)}>
          <h1>{title}</h1>
          <ChevronDown size={18} />
        </button>
        {space && (
          <IconButton label="Space options" onClick={(e) => openMenuAt(e.currentTarget, spaceMenu(space, folderId))}>
            <Ellipsis size={18} />
          </IconButton>
        )}
        <div className="grow" />
        <div className="search-box">
          <Search size={14} />
          <input className="input" placeholder="Search projects" aria-label="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {view.kind !== 'trash' && (
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => openStartDialog({ spaceId: space?.id, folderId })}>
            New project
          </Button>
        )}
      </header>

      {view.kind === 'trash' && <p className="muted page-note">{TRASH_NOTE}</p>}

      {view.kind === 'space' && crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Folder path">
          <button type="button" onClick={() => goTo({ kind: 'space', spaceId: view.spaceId, folderId: null })}>
            {space?.name}
          </button>
          {crumbs.map((c) => (
            <span key={c.id} className="row">
              <ChevronRight size={13} />
              <button type="button" onClick={() => goTo({ kind: 'space', spaceId: view.spaceId, folderId: c.id })}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
      )}

      {folders.length > 0 && (
        <div className="folder-grid">
          {folders.map((f) => (
            <div key={f.id} className="folder-card" onContextMenu={(e) => openContextMenu(e, folderMenu(f))}>
              <button type="button" className="folder-open" onClick={() => goTo({ kind: 'space', spaceId: f.spaceId, folderId: f.id })}>
                <FolderIcon size={17} />
                <span className="truncate">{f.name}</span>
              </button>
              <IconButton small label={`Options for ${f.name}`} onClick={(e) => openMenuAt(e.currentTarget, folderMenu(f), 'end')}>
                <Ellipsis size={15} />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {projects.length ? (
        <div className="project-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} meta={p} selected={picked.has(p.id)} showSelection={selected.length > 0} onToggle={() => toggle(p.id)} />
          ))}
        </div>
      ) : query ? (
        <EmptyState icon={<Search size={22} />} title="No projects found">
          <p>Nothing matches “{query}”.</p>
        </EmptyState>
      ) : view.kind === 'trash' ? (
        <EmptyState icon={<Trash2 size={22} />} title="Trash is empty" />
      ) : !folders.length ? (
        <EmptyState icon={<Clapperboard size={22} />} title="No projects here yet">
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => openStartDialog({ spaceId: space?.id, folderId })}>
            New project
          </Button>
        </EmptyState>
      ) : null}

      {selected.length > 0 && (
        <div className="selection-bar" role="toolbar" aria-label="Selected projects">
          <strong className="tabular">{selected.length} selected</strong>
          {view.kind === 'trash' ? (
            <>
              <Button
                icon={<RotateCcw size={14} />}
                onClick={() => {
                  void attempt(() => api.library.restoreProjects(selected));
                  clear();
                }}
              >
                Restore
              </Button>
              <Button
                variant="danger"
                icon={<Trash2 size={14} />}
                onClick={() => {
                  void deleteForever(selected).then((done) => done && clear());
                }}
              >
                Delete permanently
              </Button>
            </>
          ) : (
            <>
              <Button
                icon={<FolderInput size={14} />}
                onClick={() => {
                  void moveProjects(selected).then((moved) => moved && clear());
                }}
              >
                Move
              </Button>
              <Button
                icon={<Trash2 size={14} />}
                onClick={() => {
                  void confirmDialog({
                    title: `Move ${selected.length} project${selected.length === 1 ? '' : 's'} to Trash?`,
                    message: TRASH_NOTE,
                    confirmLabel: 'Move to Trash',
                  }).then((ok) => {
                    if (!ok) return;
                    void trashProjects(selected);
                    clear();
                  });
                }}
              >
                Delete
              </Button>
            </>
          )}
          <IconButton label="Clear selection" onClick={clear}>
            <X size={16} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
