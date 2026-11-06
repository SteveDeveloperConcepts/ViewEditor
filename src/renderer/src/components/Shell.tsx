// The dashboard frame: left menu and top bar. The menu has the ways to start something under Create,
// and the places your work lives under Library.

import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { CircleDot, CircleHelp, FileText, Film, Images, KeyRound, Keyboard, LayoutTemplate, Palette, Scissors, Settings, Sparkles, Video } from 'lucide-react';
import { APP_NAME } from '@shared/constants';
import { openConnections } from '@/ai/ConnectionsDialog';
import { openRecorder } from '@/recorder/openRecorder';
import { projectThumbUrl } from '@/lib/media';
import { startBlankProject } from '@/lib/projects';
import { openStartDialog } from '@/lib/startDialog';
import { openSettings, openShortcuts } from '@/pages/SettingsDialog';
import { useAi } from '@/store/ai';
import { useLibrary } from '@/store/library';
import { navigate, useUi, type Route } from '@/store/ui';
import { openMenuAt } from './Menu';
import { IconButton } from './ui';

function NavItem({ icon, label, note, page, onClick }: { icon: ReactNode; label: string; note?: string; page?: Route['page']; onClick: () => void }): ReactNode {
  const current = useUi((s) => s.route.page);
  return (
    <button type="button" className="nav-item" aria-current={page === current ? 'page' : undefined} onClick={onClick}>
      {icon}
      <span className="truncate">{label}</span>
      {note && <span className="nav-note">{note}</span>}
    </button>
  );
}

export function Sidebar(): ReactNode {
  const projects = useLibrary((s) => s.lib?.projects);
  const hasClaude = useLibrary((s) => s.lib?.settings.hasApiKey ?? false);
  const services = useAi((s) => s.providers.filter((p) => p.connected).length);
  const connected = services + (hasClaude ? 1 : 0);
  const recents = useMemo(
    () =>
      (projects ?? [])
        .filter((p) => !p.trashedAt)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [projects],
  );
  return (
    <nav className="sidebar" aria-label="Main">
      <button type="button" className="brand" onClick={() => void navigate({ page: 'start' })}>
        <span className="brand-mark">
          <Video size={15} />
        </span>
        <span>{APP_NAME}</span>
      </button>
      <div className="nav-heading first">Create</div>
      <NavItem icon={<Scissors size={16} />} label="Edit my footage" onClick={() => openStartDialog()} />
      <NavItem icon={<Sparkles size={16} />} label="Generate with AI" onClick={() => void startBlankProject({}, true)} />
      <NavItem icon={<FileText size={16} />} label="Video from a script" page="script" onClick={() => void navigate({ page: 'script' })} />
      <NavItem icon={<CircleDot size={16} />} label="Record" onClick={() => void openRecorder({})} />
      <div className="nav-heading">Library</div>
      <NavItem icon={<Film size={16} />} label="Projects" page="library" onClick={() => void navigate({ page: 'library', view: { kind: 'all' } })} />
      <NavItem icon={<Images size={16} />} label="Media" page="assets" onClick={() => void navigate({ page: 'assets' })} />
      <NavItem icon={<LayoutTemplate size={16} />} label="Templates" page="templates" onClick={() => void navigate({ page: 'templates' })} />
      <NavItem icon={<Palette size={16} />} label="Brand" page="brand" onClick={() => void navigate({ page: 'brand' })} />
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
      <div className="grow" />
      <NavItem icon={<KeyRound size={16} />} label="AI connections" note={connected ? `${connected} connected` : undefined} onClick={() => void openConnections()} />
      <NavItem icon={<Settings size={16} />} label="Settings" onClick={openSettings} />
    </nav>
  );
}

export function DashTop(): ReactNode {
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
    </div>
  );
}
