// The dashboard frame: left navigation and top bar.

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Blocks, CircleHelp, Clapperboard, FolderClosed, KeyRound, Keyboard, LayoutTemplate, Palette, Plus, Scissors, Settings, Sparkles, Video } from 'lucide-react';
import { APP_NAME } from '@shared/constants';
import { openConnections } from '@/ai/ConnectionsDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { openStartDialog } from '@/lib/startDialog';
import { projectThumbUrl } from '@/lib/media';
import { openSettings, openShortcuts } from '@/pages/SettingsDialog';
import { useLibrary } from '@/store/library';
import { navigate, useUi, type Route } from '@/store/ui';
import { openMenuAt } from './Menu';
import { IconButton } from './ui';

function NavItem({ icon, label, page, onClick }: { icon: ReactNode; label: string; page?: Route['page']; onClick: () => void }): ReactNode {
  const current = useUi((s) => s.route.page);
  return (
    <button type="button" className="nav-item" aria-current={page === current ? 'page' : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function Sidebar(): ReactNode {
  const projects = useLibrary((s) => s.lib?.projects);
  const recents = useMemo(
    () =>
      (projects ?? [])
        .filter((p) => !p.trashedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6),
    [projects],
  );
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <span className="brand-mark">
          <Video size={15} />
        </span>
        <span>{APP_NAME}</span>
      </div>
      <NavItem icon={<Plus size={16} />} label="Create video" page="home" onClick={() => void navigate({ page: 'home' })} />
      <NavItem icon={<Scissors size={16} />} label="Edit video" onClick={() => openStartDialog()} />
      <div className="nav-gap" />
      <NavItem icon={<Sparkles size={16} />} label="Create asset" page="create-asset" onClick={() => void navigate({ page: 'create-asset' })} />
      <NavItem icon={<FolderClosed size={16} />} label="Assets" page="assets" onClick={() => void navigate({ page: 'assets' })} />
      <NavItem icon={<Palette size={16} />} label="Brand" page="brand" onClick={() => void navigate({ page: 'brand' })} />
      <NavItem icon={<LayoutTemplate size={16} />} label="Templates" page="templates" onClick={() => void navigate({ page: 'templates' })} />
      <div className="nav-heading">Recents</div>
      <div className="recents">
        {recents.map((p) => {
          const thumb = projectThumbUrl(p);
          return (
            <button key={p.id} type="button" className="recent" title={p.name} onClick={() => void navigate({ page: 'editor', projectId: p.id })}>
              <span className="recent-thumb">{thumb && <img src={thumb} alt="" draggable={false} />}</span>
              <span className="truncate">{p.name}</span>
            </button>
          );
        })}
        {!recents.length && <p className="faint recents-empty">Your projects appear here.</p>}
      </div>
      <button type="button" className="nav-item view-all" onClick={() => void navigate({ page: 'library', view: { kind: 'all' } })}>
        View all
      </button>
      <div className="grow" />
      <button
        type="button"
        className="nav-item"
        onClick={(e) => openMenuAt(e.currentTarget, [{ label: 'Record', icon: <Clapperboard size={15} />, onSelect: () => void openRecorder({}) }])}
      >
        <Blocks size={16} />
        <span>More apps</span>
      </button>
    </nav>
  );
}

export function DashTop(): ReactNode {
  const settings = useLibrary((s) => s.lib?.settings);
  const name = settings?.profileName || settings?.workspaceName || 'V';
  return (
    <div className="dash-top">
      <IconButton
        label="Help"
        onClick={(e) =>
          openMenuAt(e.currentTarget, [{ label: 'Keyboard shortcuts', icon: <Keyboard size={15} />, onSelect: openShortcuts }], 'end')
        }
      >
        <CircleHelp size={17} />
      </IconButton>
      <button
        type="button"
        className="avatar"
        aria-label="Workspace menu"
        title={settings?.workspaceName}
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            [
              settings?.workspaceName ?? 'Workspace',
              { label: 'AI connections', icon: <KeyRound size={15} />, onSelect: openConnections },
              { label: 'Settings', icon: <Settings size={15} />, onSelect: openSettings },
            ],
            'end',
          )
        }
      >
        {name.trim().charAt(0).toUpperCase()}
      </button>
    </div>
  );
}
