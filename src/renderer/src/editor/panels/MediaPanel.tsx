// The Video, Image and Audio panels: add files to the project, and use what is already in Media.

import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { AudioLines, CircleAlert, Image as ImageIcon, Mic, Music, Plus, Search, Speech, Upload, Video } from 'lucide-react';
import { formatClock } from '@shared/time';
import type { Asset, AssetKind, ID } from '@shared/types';
import { openMenuAt, type MenuEntry } from '@/components/Menu';
import { Button, Spinner } from '@/components/ui';
import { assetUrl } from '@/lib/media';
import { addAsset, selectedItems } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { toast } from '@/store/ui';
import { addSoundOf, extractAudioFrom } from '../actions';
import { ASSET_DRAG_TYPE, droppedPaths, hasFiles, importPathsIntoProject, pickIntoProject, SUPPORTED_SUMMARY } from '../importing';
import { openRecorder } from '@/recorder/openRecorder';
import { openSpeechDialog } from './SpeechDialog';

const TITLES: Record<AssetKind, string> = { video: 'Video', image: 'Image', audio: 'Audio' };

export function AssetTile({ asset, onAdd }: { asset: Asset; onAdd: (a: Asset) => void }): ReactNode {
  const onDragStart = (e: ReactDragEvent): void => {
    e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
    e.dataTransfer.effectAllowed = 'copy';
  };
  const busy = asset.proxy === 'pending';
  const broken = asset.proxy === 'failed';
  return (
    <button
      type="button"
      className="asset-tile"
      draggable
      onDragStart={onDragStart}
      onClick={() => onAdd(asset)}
      title={`${asset.name}\nClick to add at the playhead, or drag onto the timeline`}
    >
      <div className={`asset-tile-picture ${asset.kind}`}>
        {asset.hasThumb ? (
          <img src={assetUrl(asset, 'thumb')} alt="" draggable={false} loading="lazy" />
        ) : asset.kind === 'audio' ? (
          asset.hasWave ? <img className="wave" src={assetUrl(asset, 'wave')} alt="" draggable={false} loading="lazy" /> : <Music size={20} />
        ) : asset.kind === 'video' ? (
          <Video size={20} />
        ) : (
          <ImageIcon size={20} />
        )}
        {asset.kind !== 'image' && <span className="badge dark tabular">{formatClock(asset.duration)}</span>}
        {busy && (
          <span className="asset-tile-busy" title="Preparing preview">
            <Spinner />
          </span>
        )}
        {broken && (
          <span className="asset-tile-busy" title="The preview could not be prepared. The file will still export.">
            <CircleAlert size={16} />
          </span>
        )}
        <span className="asset-tile-add">
          <Plus size={14} />
        </span>
      </div>
      <span className="asset-tile-name truncate">{asset.name}</span>
    </button>
  );
}

/** What the Audio panel can take sound from: the selected clip, your videos, or a file on the computer. */
function extractEntries(assets: Asset[], projectId: ID): MenuEntry[] {
  const selected = selectedItems();
  const clip = selected.length === 1 && selected[0].type === 'video' ? selected[0] : null;
  const videos = assets.filter((a) => a.kind === 'video' && a.hasAudio).reverse().slice(0, 8);
  return [
    clip && { label: 'The selected clip', onSelect: () => void extractAudioFrom(clip) },
    clip && null,
    videos.length > 0 && 'From your media',
    ...videos.map((a) => ({ label: a.name, onSelect: () => void addSoundOf(a) })),
    videos.length > 0 && null,
    {
      label: 'A video on your computer…',
      onSelect: () => {
        void pickIntoProject('video', projectId, false).then((added) => {
          const video = added.find((a) => a.hasAudio);
          if (video) void addSoundOf(video);
          else if (added.length) toast(`${added[0].name} has no sound.`);
        });
      },
    },
  ];
}

export function MediaPanel({ kind, projectId }: { kind: AssetKind; projectId: ID }): ReactNode {
  const assets = useLibrary((s) => s.lib?.assets);
  const [query, setQuery] = useState('');
  const [over, setOver] = useState(false);

  const { project, workspace } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (assets ?? []).filter((a) => a.kind === kind && (!q || a.name.toLowerCase().includes(q))).reverse();
    return {
      project: list.filter((a) => a.scope === 'project' && a.projectId === projectId),
      workspace: list.filter((a) => a.scope === 'workspace'),
    };
  }, [assets, kind, projectId, query]);

  const onAdd = (a: Asset): void => void addAsset(a, { atPlayhead: true, chain: true });
  const none = !project.length && !workspace.length;

  return (
    <div className="panel-body">
      <h2 className="panel-title">{TITLES[kind]}</h2>
      <div
        className={`dropzone compact${over ? ' over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => void pickIntoProject(kind, projectId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') void pickIntoProject(kind, projectId);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          void importPathsIntoProject(droppedPaths(e.dataTransfer), projectId);
        }}
      >
        <Upload size={18} />
        <div>
          <strong>Add {kind === 'image' ? 'images' : kind}</strong>
          <div className="faint">Drag and drop, or click to browse</div>
        </div>
      </div>
      {kind === 'video' && (
        <div className="panel-actions">
          <Button icon={<Video size={14} />} onClick={() => void openRecorder({ projectId, addToTimeline: true })}>
            Record
          </Button>
          <Button icon={<Speech size={14} />} onClick={() => openSpeechDialog(projectId)}>
            Text to speech
          </Button>
        </div>
      )}
      {kind === 'audio' && (
        <div className="panel-actions">
          <Button icon={<Mic size={14} />} onClick={() => void openRecorder({ projectId, addToTimeline: true, mode: 'audio' })}>
            Voice-over
          </Button>
          <Button icon={<Speech size={14} />} onClick={() => openSpeechDialog(projectId)}>
            Text to speech
          </Button>
          <Button className="span-2" icon={<AudioLines size={14} />} onClick={(e) => openMenuAt(e.currentTarget, extractEntries(assets ?? [], projectId))}>
            Extract audio from a video
          </Button>
        </div>
      )}
      {(assets ?? []).some((a) => a.kind === kind) && (
        <div className="panel-search">
          <Search size={14} />
          <input className="input small" placeholder={`Search ${TITLES[kind].toLowerCase()}`} aria-label={`Search ${TITLES[kind].toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {project.length > 0 && (
        <section>
          <h3>In this project</h3>
          <div className="asset-grid">
            {project.map((a) => (
              <AssetTile key={a.id} asset={a} onAdd={onAdd} />
            ))}
          </div>
        </section>
      )}
      {workspace.length > 0 && (
        <section>
          <h3>Your media</h3>
          <div className="asset-grid">
            {workspace.map((a) => (
              <AssetTile key={a.id} asset={a} onAdd={onAdd} />
            ))}
          </div>
        </section>
      )}
      {none && <p className="faint panel-note">{query ? 'Nothing matches that search.' : SUPPORTED_SUMMARY}</p>}
    </div>
  );
}
