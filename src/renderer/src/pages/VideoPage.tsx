// The video page: where an export renders, plays back and is downloaded.

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Download, FileAudio, FileVideo, FolderOpen, Image as ImageIcon, Plus, RefreshCw, Scissors, Type } from 'lucide-react';
import { formatBytes, formatClock, formatRelative } from '@shared/time';
import type { ProjectMeta, RenderProgress } from '@shared/types';
import { Button, Notice, ProgressBar, Spinner } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { exportUrl, projectThumbUrl } from '@/lib/media';
import { isRendering, useLibrary } from '@/store/library';
import { navigate, toast } from '@/store/ui';

function Rendering({ meta, render }: { meta: ProjectMeta; render: RenderProgress }): ReactNode {
  const thumb = projectThumbUrl(meta);
  const label = render.state === 'preparing' ? 'Preparing…' : render.state === 'finishing' ? 'Finishing…' : `Rendering ${Math.round(render.progress * 100)}%`;
  return (
    <div className="render-card">
      <div className="render-picture">{thumb ? <img src={thumb} alt="" draggable={false} /> : <Spinner large />}</div>
      <div className="col">
        <div className="row">
          <strong className="grow tabular">{label}</strong>
          <Button size="small" variant="ghost" onClick={() => void api.render.cancel()}>
            Cancel
          </Button>
        </div>
        <ProgressBar value={render.progress} />
        <p className="faint">You can keep working. The render carries on in the background while the app is open.</p>
      </div>
    </div>
  );
}

function DownloadButton({ meta, format, icon, title, hint }: { meta: ProjectMeta; format: 'mp4' | 'mp3' | 'gif'; icon: ReactNode; title: string; hint: string }): ReactNode {
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await api.render.download(meta.id, format);
      if (path) toast(`Saved ${format.toUpperCase()}.`, { kind: 'success', action: { label: 'Show', run: () => void api.app.showItemInFolder(path) } });
    } catch (err) {
      toast(errorMessage(err), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="download-option" disabled={busy} onClick={() => void save()}>
      {busy ? <Spinner /> : icon}
      <span className="grow">
        <strong>{title}</strong>
        <span className="faint">{hint}</span>
      </span>
      <Download size={15} />
    </button>
  );
}

export function VideoPage({ projectId }: { projectId: string }): ReactNode {
  const meta = useLibrary((s) => s.lib?.projects.find((p) => p.id === projectId));
  const render = useLibrary((s) => s.render);
  const [failure, setFailure] = useState('');
  const ownRender = render?.projectId === projectId && render.kind === 'export' ? render : null;
  const rendering = isRendering(render, projectId);

  useEffect(() => {
    if (ownRender?.state === 'error') setFailure(ownRender.message ?? 'The export failed.');
    else if (ownRender && rendering) setFailure('');
  }, [ownRender, rendering]);

  if (!meta) {
    return (
      <div className="page">
        <p className="muted">This project no longer exists.</p>
      </div>
    );
  }

  const url = exportUrl(meta);
  const info = meta.lastExport;
  const origin = meta.scriptOrigin;

  return (
    <div className="page video-page">
      <header className="page-head">
        <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={() => void navigate({ page: 'library', view: { kind: 'all' } })}>
          Projects
        </Button>
        <h1 className="truncate grow">{meta.name}</h1>
        <Button icon={<Scissors size={15} />} onClick={() => void navigate({ page: 'editor', projectId })}>
          Edit
        </Button>
      </header>

      {failure && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          <strong>The export did not finish.</strong>
          <div className="selectable pre">{failure}</div>
        </Notice>
      )}

      {rendering && ownRender ? (
        <Rendering meta={meta} render={ownRender} />
      ) : url && info ? (
        <div className="video-layout">
          <div className="video-main">
            <video
              key={info.id}
              src={url}
              controls
              playsInline
              className="video-player"
              // As wide as the column allows, but never so wide that a tall video runs off the window.
              style={{ aspectRatio: `${info.width} / ${info.height}`, width: `min(100%, calc((100vh - 170px) * ${(info.width / info.height).toFixed(4)}))` }}
            />
            <p className="faint tabular">
              {info.width} × {info.height} · {info.fps} fps · {formatClock(info.duration)} · {formatBytes(info.size)} · {info.presetLabel} · exported {formatRelative(info.createdAt)}
            </p>
          </div>
          <aside className="video-side">
            {meta.editedSinceExport && (
              <Notice kind="warning" icon={<RefreshCw size={15} />}>
                This project has changed since it was exported. Open it and press Export to export the changes.
              </Notice>
            )}
            <h2>Download</h2>
            <DownloadButton meta={meta} format="mp4" icon={<FileVideo size={18} />} title="MP4" hint="Video with sound" />
            <DownloadButton meta={meta} format="mp3" icon={<FileAudio size={18} />} title="MP3" hint="Audio only" />
            <DownloadButton meta={meta} format="gif" icon={<ImageIcon size={18} />} title="GIF" hint="Small, silent and looping" />
            <Button variant="ghost" icon={<FolderOpen size={15} />} onClick={() => void api.render.revealExport(projectId)}>
              Show in folder
            </Button>
            {origin && (
              <>
                <h2>Make a variant</h2>
                {origin.mode === 'topic' && (
                  <Button icon={<RefreshCw size={15} />} onClick={() => void navigate({ page: 'script', prefill: { ...origin, script: '', mode: 'topic' } })}>
                    Reuse topic
                  </Button>
                )}
                <Button icon={<Type size={15} />} onClick={() => void navigate({ page: 'script', prefill: { ...origin, mode: 'script' } })}>
                  Reuse script
                </Button>
                <Button icon={<Plus size={15} />} onClick={() => void navigate({ page: 'script' })}>
                  New video
                </Button>
              </>
            )}
          </aside>
        </div>
      ) : (
        <div className="empty">
          <h2>{ownRender?.state === 'cancelled' ? 'The export was cancelled' : 'This project has not been exported yet'}</h2>
          <p>Open it in the editor and press Export. It can be saved once it has been exported.</p>
          <Button variant="primary" onClick={() => void navigate({ page: 'editor', projectId })}>
            Open in editor
          </Button>
        </div>
      )}
    </div>
  );
}
