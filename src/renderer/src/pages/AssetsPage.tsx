// Media: everything kept in the library, ready to use in any project.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Ellipsis, FolderUp, Image as ImageIcon, Music, Scissors, Trash2, Upload, Video, Wand2 } from 'lucide-react';
import { formatBytes, formatClock } from '@shared/time';
import type { Asset, AssetKind } from '@shared/types';
import { JobList } from '@/ai/JobList';
import { openContextMenu, openMenuAt, type MenuEntry } from '@/components/Menu';
import { confirmDialog } from '@/components/Modal';
import { Button, EmptyState, IconButton, ProgressBar, Segmented } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { assetUrl } from '@/lib/media';
import { startProjectWithAsset } from '@/lib/projects';
import { droppedPaths, hasFiles, reportRejected, SUPPORTED_SUMMARY } from '@/editor/importing';
import { useLibrary } from '@/store/library';
import { navigate, toast } from '@/store/ui';

type Filter = 'all' | AssetKind;

async function removeAsset(asset: Asset): Promise<void> {
  try {
    const usage = (await api.assets.usage())[asset.id] ?? 0;
    const ok = await confirmDialog({
      title: `Delete “${asset.name}”?`,
      message: usage
        ? `This file is used in ${usage} project${usage === 1 ? '' : 's'}. Deleting it leaves a “media missing” gap there.`
        : 'The file is removed from this library. The original on your computer is not touched.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await api.assets.remove([asset.id]);
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function menuFor(asset: Asset): MenuEntry[] {
  return [
    { label: 'Start a project with this', icon: <Scissors size={15} />, onSelect: () => void startProjectWithAsset(asset, asset.name.replace(/\.[^.]+$/, '')).catch((err) => toast(errorMessage(err), { kind: 'error' })) },
    null,
    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => void removeAsset(asset) },
  ];
}

function AssetCard({ asset }: { asset: Asset }): ReactNode {
  return (
    <article className="asset-card" onContextMenu={(e) => openContextMenu(e, menuFor(asset))}>
      <div className={`asset-card-picture ${asset.kind}`}>
        {asset.hasThumb ? (
          <img src={assetUrl(asset, 'thumb')} alt="" draggable={false} loading="lazy" />
        ) : asset.kind === 'audio' && asset.hasWave ? (
          <img className="wave" src={assetUrl(asset, 'wave')} alt="" draggable={false} loading="lazy" />
        ) : asset.kind === 'audio' ? (
          <Music size={24} />
        ) : asset.kind === 'video' ? (
          <Video size={24} />
        ) : (
          <ImageIcon size={24} />
        )}
        {asset.kind !== 'image' && <span className="badge dark tabular">{formatClock(asset.duration)}</span>}
      </div>
      <div className="project-meta">
        <div className="grow">
          <div className="project-name-label truncate" title={asset.name}>
            {asset.name}
          </div>
          <div className="faint tabular">
            {asset.kind === 'audio' ? 'Audio' : `${asset.width} × ${asset.height}`} · {formatBytes(asset.size)}
          </div>
        </div>
        <IconButton small label={`Options for ${asset.name}`} onClick={(e) => openMenuAt(e.currentTarget, menuFor(asset), 'end')}>
          <Ellipsis size={16} />
        </IconButton>
      </div>
    </article>
  );
}

export function AssetsPage(): ReactNode {
  const assets = useLibrary((s) => s.lib?.assets);
  const importing = useLibrary((s) => s.importing);
  const [filter, setFilter] = useState<Filter>('all');
  const [over, setOver] = useState(false);

  const list = useMemo(() => (assets ?? []).filter((a) => a.scope === 'workspace' && (filter === 'all' || a.kind === filter)).reverse(), [assets, filter]);

  const upload = async (): Promise<void> => {
    try {
      const result = await api.assets.pickAndImport('media', { scope: 'workspace' });
      if (result) reportRejected(result);
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    }
  };

  return (
    <div
      className={`page${over ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void api.assets.importPaths(droppedPaths(e.dataTransfer), { scope: 'workspace' }).then(reportRejected, (err) => toast(errorMessage(err), { kind: 'error' }));
      }}
    >
      <header className="page-head">
        <h1>Media</h1>
        <div className="grow" />
        <Segmented<Filter>
          label="Filter assets"
          value={filter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'video', label: 'Video' },
            { value: 'audio', label: 'Audio' },
            { value: 'image', label: 'Images' },
          ]}
          onChange={setFilter}
        />
        <Button icon={<Wand2 size={15} />} onClick={() => void navigate({ page: 'create-asset' })}>
          Make a background
        </Button>
        <Button variant="primary" icon={<Upload size={15} />} onClick={() => void upload()}>
          Upload
        </Button>
      </header>
      <JobList projectId={null} />
      {importing && (
        <div className="import-progress">
          <span className="truncate">
            Adding {importing.name} ({importing.done + 1} of {importing.total})
          </span>
          <ProgressBar value={(importing.done + 0.5) / importing.total} />
        </div>
      )}
      {list.length ? (
        <div className="project-grid">
          {list.map((a) => (
            <AssetCard key={a.id} asset={a} />
          ))}
        </div>
      ) : (
        <EmptyState icon={<FolderUp size={22} />} title={filter === 'all' ? 'Your asset library is empty' : 'Nothing here yet'}>
          <p>Files you add here are available in every project. Drag them onto this page or use Upload.</p>
          <p className="faint">{SUPPORTED_SUMMARY}</p>
        </EmptyState>
      )}
    </div>
  );
}
