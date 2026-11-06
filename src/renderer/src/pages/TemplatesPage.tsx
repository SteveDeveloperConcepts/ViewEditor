// Templates: reusable starting points saved from projects.

import type { ReactNode } from 'react';
import { useState } from 'react';
import { Ellipsis, LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatClock } from '@shared/time';
import type { TemplateMeta } from '@shared/types';
import { openContextMenu, openMenuAt, type MenuEntry } from '@/components/Menu';
import { confirmDialog, Modal, promptDialog } from '@/components/Modal';
import { Button, EmptyState, Field, IconButton } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { templateThumbUrl } from '@/lib/media';
import { getLibrary, useLibrary } from '@/store/library';
import { navigate, showModal, toast } from '@/store/ui';

async function attempt(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function startFromTemplate(t: TemplateMeta): void {
  void attempt(async () => {
    const meta = await api.library.createFromTemplate(t.id);
    await navigate({ page: 'editor', projectId: meta.id });
  });
}

function menuFor(t: TemplateMeta): MenuEntry[] {
  return [
    { label: 'Use template', icon: <Plus size={15} />, onSelect: () => startFromTemplate(t) },
    {
      label: 'Rename',
      icon: <Pencil size={15} />,
      onSelect: () => {
        void promptDialog({ title: 'Rename template', label: 'Name', value: t.name }).then((name) => {
          if (name) void attempt(() => api.library.renameTemplate(t.id, name));
        });
      },
    },
    null,
    {
      label: 'Delete',
      icon: <Trash2 size={15} />,
      danger: true,
      onSelect: () => {
        void confirmDialog({ title: `Delete “${t.name}”?`, message: 'Projects made from this template are not affected.', confirmLabel: 'Delete', danger: true }).then((ok) => {
          if (ok) void attempt(() => api.library.deleteTemplate(t.id));
        });
      },
    },
  ];
}

function CreateBody({ close }: { close: () => void }): ReactNode {
  const projects = getLibrary().projects.filter((p) => !p.trashedAt);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [name, setName] = useState(projects[0]?.name ?? '');
  return (
    <Modal
      title="Create a template"
      onClose={close}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!projectId || !name.trim()}
            onClick={() => {
              void attempt(async () => {
                await api.library.saveAsTemplate(projectId, name);
                close();
              });
            }}
          >
            Save template
          </Button>
        </>
      }
    >
      {projects.length ? (
        <>
          <Field label="From project">
            <select
              className="select"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setName(projects.find((p) => p.id === e.target.value)?.name ?? name);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Template name">
            <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
        </>
      ) : (
        <p>Templates are made from projects. Create a project first.</p>
      )}
    </Modal>
  );
}

export function TemplatesPage(): ReactNode {
  const templates = useLibrary((s) => s.lib?.templates) ?? [];
  const create = (): void => void showModal<void>((close) => <CreateBody close={() => close()} />);
  return (
    <div className="page">
      <header className="page-head">
        <h1>Templates</h1>
        <div className="grow" />
        <Button variant="primary" icon={<Plus size={15} />} onClick={create}>
          Create template
        </Button>
      </header>
      {templates.length ? (
        <div className="project-grid">
          {templates.map((t) => {
            const thumb = templateThumbUrl(t);
            return (
              <article key={t.id} className="project-card" onContextMenu={(e) => openContextMenu(e, menuFor(t))}>
                <button type="button" className="project-thumb" aria-label={`Use ${t.name}`} onClick={() => startFromTemplate(t)}>
                  {thumb ? <img src={thumb} alt="" draggable={false} loading="lazy" /> : <LayoutTemplate size={26} />}
                  {t.duration > 0 && <span className="badge dark tabular project-duration">{formatClock(t.duration)}</span>}
                </button>
                <div className="project-meta">
                  <div className="project-name-label grow truncate" title={t.name}>
                    {t.name}
                  </div>
                  <IconButton small label={`Options for ${t.name}`} onClick={(e) => openMenuAt(e.currentTarget, menuFor(t), 'end')}>
                    <Ellipsis size={16} />
                  </IconButton>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={<LayoutTemplate size={22} />} title="No templates yet">
          <p>Save any project as a template, then start new videos from it with the layout already in place.</p>
          <Button variant="primary" icon={<Plus size={15} />} onClick={create}>
            Create template
          </Button>
        </EmptyState>
      )}
    </div>
  );
}
