// Media: everything kept in the library, ready to use in any project.

import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Ellipsis, FolderUp, Image as ImageIcon, Music, Search, Upload, Video, Wand2 } from 'lucide-react';
import { formatBytes, formatClock } from '@shared/time';
import type { Asset, AssetKind } from '@shared/types';
import { JobList } from '@/ai/JobList';
import { openContextMenu, openMenuAt } from '@/components/Menu';
import { Button, EmptyState, IconButton, ProgressBar, Segmented } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { assetUrl } from '@/lib/media';
import { mediaMenu, openPreview } from '@/lib/mediaActions';
import { droppedPaths, hasFiles, reportRejected, SUPPORTED_SUMMARY } from '@/editor/importing';
import { useLibrary } from '@/store/library';
import { navigate, toast } from '@/store/ui';

type Filter = 'all' | AssetKind;

function AssetCard({ asset }: { asset: Asset }): ReactNode {
  return (
    <article className="asset-card" onContextMenu={(e) => openContextMenu(e, mediaMenu(asset))}>
      <button type="button" className={`asset-card-picture ${asset.kind}`} aria-label={`Preview ${asset.name}`} onClick={() => openPreview(asset)}>
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
      </button>
      <div className="project-meta">
        <div className="grow">
          <div className="project-name-label truncate" title={asset.name}>
            {asset.name}
          </div>
          <div className="faint tabular">
            {asset.kind === 'audio' ? 'Audio' : `${asset.width} × ${asset.height}`} · {formatBytes(asset.size)}
          </div>
        </div>
        <IconButton small label={`Options for ${asset.name}`} onClick={(e) => openMenuAt(e.currentTarget, mediaMenu(asset), 'end')}>
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
  const [query, setQuery] = useState('');
  const [over, setOver] = useState(false);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (assets ?? []).filter((a) => (filter === 'all' || a.kind === filter) && (!q || a.name.toLowerCase().includes(q))).reverse();
  }, [assets, filter, query]);

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
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        void api.assets.importPaths(droppedPaths(e.dataTransfer), { scope: 'workspace' }).then(reportRejected, (err) => toast(errorMessage(err), { kind: 'error' }));
      }}
    >
      <header className="page-head">
        <h1>Media</h1>
        <div className="grow" />
        <div className="search-box">
          <Search size={14} />
          <input className="input" placeholder="Search media" aria-label="Search media" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Segmented<Filter>
          label="Filter media"
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
          Add files
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
        <EmptyState icon={<FolderUp size={22} />} title={query ? 'Nothing matches that search' : filter === 'all' ? 'No media yet' : 'Nothing here yet'}>
          <p>Everything you add, record or generate is kept here, ready for any project. Drag files onto this page or use Add files.</p>
          <p className="faint">{SUPPORTED_SUMMARY}</p>
        </EmptyState>
      )}
    </div>
  );
}
