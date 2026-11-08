// Free clips: search stock video, watch a clip, and bring it into Media or onto the timeline.

import type { FormEvent, ReactNode } from 'react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, ExternalLink, KeyRound, Plus, Search, Video, X } from 'lucide-react';
import { DEFAULT_CLIP_SIZE, type ClipServiceId, type ClipServiceStatus, type ClipShape, type FreeClip } from '@shared/clips';
import { fileTitle } from '@shared/constants';
import { formatClock } from '@shared/time';
import { Modal } from '@/components/Modal';
import { Button, IconButton, Notice, ProgressBar, Segmented, Spinner } from '@/components/ui';
import { addToTimeline, rememberAssets } from '@/editor/importing';
import { api, errorMessage } from '@/lib/api';
import { clipUrl } from '@/lib/media';
import { openPreview } from '@/lib/mediaActions';
import { clipServicesChanged, fetchClip, loadClipServices, retryClips, searchClips, setClipText, showMoreClips, useClips } from '@/store/clips';
import { useEditor } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { showModal, toast } from '@/store/ui';

const SHAPES: { value: ClipShape; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'wide', label: 'Wide' },
  { value: 'tall', label: 'Tall' },
  { value: 'square', label: 'Square' },
];

const KEY_NOTE = 'Keys are encrypted on this computer. What you search for goes to the services you connect.';

function outside(href: string, children: ReactNode): ReactNode {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Brings a clip into Media, and onto the timeline when a project is open and that is what was asked for. */
async function addClip(clip: FreeClip, toTimeline = true): Promise<void> {
  const doc = useEditor.getState().doc;
  try {
    const fit = doc ? { width: doc.settings.width, height: doc.settings.height } : DEFAULT_CLIP_SIZE;
    const asset = await fetchClip(clip, fit);
    if (!asset) return;
    if (doc && toTimeline && useEditor.getState().doc?.id === doc.id) {
      await addToTimeline([asset], { atPlayhead: true, chain: true });
    } else {
      rememberAssets([asset]);
      toast(`${fileTitle(asset.name)} is in Media.`, { kind: 'success', action: { label: 'Use it', run: () => openPreview(asset) } });
    }
  } catch (err) {
    toast(errorMessage(err), { kind: 'error' });
  }
}

function ClipPreview(props: { clip: FreeClip; service: ClipServiceStatus; kept: boolean; close: () => void }): ReactNode {
  const { clip, service, kept, close } = props;
  const open = !!useEditor.getState().doc;
  const [broken, setBroken] = useState(false);
  const add = (toTimeline: boolean) => () => {
    close();
    void addClip(clip, toTimeline);
  };
  return (
    <Modal
      title={clip.title}
      size="wide"
      onClose={close}
      footer={
        <>
          {open && (
            <Button variant="primary" icon={<Plus size={15} />} onClick={add(true)}>
              Add to timeline
            </Button>
          )}
          {!kept && (
            <Button variant={open ? 'default' : 'primary'} icon={open ? undefined : <Plus size={15} />} onClick={add(false)}>
              Add to Media
            </Button>
          )}
          {kept && !open && (
            <Button icon={<Check size={15} />} disabled>
              In Media
            </Button>
          )}
        </>
      }
    >
      <div className="preview-stage">
        <video src={clipUrl(clip.key, 'preview')} poster={clip.picture ? clipUrl(clip.key, 'picture') : undefined} controls playsInline onError={() => setBroken(true)} />
      </div>
      {broken && (
        <Notice kind="warning" icon={<CircleAlert size={15} />}>
          This preview could not be played. You can still add the clip.
        </Notice>
      )}
      <p className="faint tabular">
        {clip.width} × {clip.height} · {formatClock(clip.duration)}
      </p>
      <p className="muted">
        Video by {clip.creatorUrl ? outside(clip.creatorUrl, clip.creator) : clip.creator} on {outside(clip.pageUrl, service.name)}
      </p>
      <p className="faint">
        {service.terms} {outside(service.licenseUrl, 'Read the licence')}
      </p>
    </Modal>
  );
}

function ClipTile({ clip, service, kept }: { clip: FreeClip; service: ClipServiceStatus; kept: boolean }): ReactNode {
  const progress = useClips((s) => s.downloads[clip.key]);
  const open = useEditor((s) => !!s.doc);
  const busy = progress !== undefined;
  const watch = (): void => void showModal<void>((close) => <ClipPreview clip={clip} service={service} kept={kept} close={() => close()} />);
  return (
    <article className="free-clip" data-free-clip={clip.key}>
      <div className="clip-frame">
        <button type="button" className="asset-tile-picture" aria-label={`Watch ${clip.title}`} title={`${clip.title}\nClick to watch`} onClick={watch}>
          {clip.picture ? <img src={clipUrl(clip.key, 'picture')} alt="" draggable={false} loading="lazy" /> : <Video size={20} />}
          <span className="badge dark tabular">{formatClock(clip.duration)}</span>
        </button>
        {kept && !busy && (
          <span className="badge dark clip-kept">
            <Check size={10} /> In Media
          </span>
        )}
        {busy ? (
          <div className="clip-dl">
            {progress === null ? <Spinner /> : <ProgressBar value={progress} />}
            <IconButton small label={`Stop downloading ${clip.title}`} onClick={() => void api.clips.cancel(clip.key)}>
              <X size={13} />
            </IconButton>
          </div>
        ) : (
          (open || !kept) && (
            <button type="button" className="clip-add" aria-label={`Add ${clip.title}`} title={open ? 'Add to the timeline' : 'Add to Media'} onClick={() => void addClip(clip)}>
              <Plus size={14} />
            </button>
          )
        )}
      </div>
      <span className="clip-by truncate" title={`${clip.creator} on ${service.name}`}>
        {clip.creator}
        <span className="clip-via"> · {service.name}</span>
      </span>
    </article>
  );
}

function ServiceCard({ service }: { service: ClipServiceStatus }): ReactNode {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.clips.connect(service.id, key);
      await clipServicesChanged();
      toast(`${service.name} connected.`, { kind: 'success' });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    await api.clips.disconnect(service.id);
    await clipServicesChanged();
  };

  return (
    <section className="provider-card" data-clip-service={service.id}>
      <div className="row">
        <h3 className="grow provider-name">{service.name}</h3>
        {service.connected && (
          <span className="badge success">
            <KeyRound size={11} /> Connected
          </span>
        )}
      </div>
      <p>{service.tagline}</p>
      {service.connected ? (
        <div className="row">
          <span className="grow" />
          <Button size="small" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </div>
      ) : (
        <>
          <a className="btn" href={service.keyUrl} target="_blank" rel="noreferrer">
            Get a free key <ExternalLink size={13} />
          </a>
          <div className="row">
            <input
              className="input grow"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${service.name} API key`}
              placeholder="Paste the key here"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && key.trim()) {
                  e.preventDefault();
                  void connect();
                }
              }}
            />
            <Button variant="primary" disabled={!key.trim() || busy} icon={busy ? <Spinner /> : undefined} onClick={() => void connect()}>
              Connect
            </Button>
          </div>
        </>
      )}
      {error && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {error}
        </Notice>
      )}
    </section>
  );
}

function ServicesBody({ close }: { close: () => void }): ReactNode {
  const services = useClips((s) => s.services);
  return (
    <Modal title="Free clip services" onClose={close} footer={<Button variant="primary" onClick={close}>Done</Button>}>
      {services?.map((s) => <ServiceCard key={s.id} service={s} />)}
      <Notice icon={<KeyRound size={14} />}>{KEY_NOTE}</Notice>
    </Modal>
  );
}

function openClipServices(): void {
  void showModal<void>((close) => <ServicesBody close={() => close()} />);
}

function ConnectFirst({ services }: { services: ClipServiceStatus[] }): ReactNode {
  return (
    <div className="clip-connect">
      <p className="muted">Search free videos and add them to your project without leaving the app. Connect one of these services with a free key. You only do this once.</p>
      {services.map((s) => (
        <ServiceCard key={s.id} service={s} />
      ))}
      <p className="faint panel-note">{KEY_NOTE}</p>
    </div>
  );
}

function Browser({ services }: { services: ClipServiceStatus[] }): ReactNode {
  const text = useClips((s) => s.text);
  const shape = useClips((s) => s.shape);
  const shown = useClips((s) => s.shown);
  const clips = useClips((s) => s.clips);
  const hasMore = useClips((s) => s.hasMore);
  const searching = useClips((s) => s.searching);
  const problem = useClips((s) => s.problem);
  const notes = useClips((s) => s.notes);
  const assets = useLibrary((s) => s.lib?.assets);
  const kept = useMemo(() => new Set((assets ?? []).flatMap((a) => (a.credit ? [a.credit.key] : []))), [assets]);
  const byId = useMemo(() => new Map<ClipServiceId, ClipServiceStatus>(services.map((s) => [s.id, s])), [services]);

  useEffect(() => {
    if (!useClips.getState().shown) void searchClips();
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    void searchClips({ query: text });
  };

  return (
    <>
      <form className="clip-find" onSubmit={submit}>
        <div className="panel-search grow">
          <Search size={14} />
          <input className="input small" placeholder="Search free clips" aria-label="Search free clips" maxLength={100} value={text} onChange={(e) => setClipText(e.target.value)} />
        </div>
        <Button type="submit" size="small" disabled={searching}>
          Search
        </Button>
      </form>
      <Segmented<ClipShape> fill label="Shape of the clips" value={shape} options={SHAPES} onChange={(v) => void (v !== shape && searchClips({ shape: v }))} />
      <p className="clip-sources">
        <span>
          Videos provided by{' '}
          {services.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && ' and '}
              {outside(s.homeUrl, s.name)}
            </Fragment>
          ))}
        </span>
        <button type="button" className="link-btn" onClick={openClipServices}>
          Manage
        </button>
      </p>
      {notes.map((note) => (
        <Notice key={note} kind="warning" icon={<CircleAlert size={15} />}>
          {note}
        </Notice>
      ))}
      {problem && (
        <Notice kind="error" icon={<CircleAlert size={15} />}>
          {problem}{' '}
          <button type="button" className="link-btn inline" onClick={() => void retryClips()}>
            Try again
          </button>
        </Notice>
      )}
      {clips.length > 0 && (
        <section>
          <h3 className="truncate">{shown?.query ? `Results for “${shown.query}”` : 'Popular'}</h3>
          <div className="clip-grid">
            {clips.map((c) => {
              const service = byId.get(c.service);
              return service ? <ClipTile key={c.key} clip={c} service={service} kept={kept.has(c.key)} /> : null;
            })}
          </div>
        </section>
      )}
      {searching && (
        <div className="clip-wait">
          <Spinner />
        </div>
      )}
      {!searching && !problem && !clips.length && <p className="faint panel-note">{hasMore ? 'Nothing of this shape on this page of results.' : 'No clips match that. Try fewer or different words.'}</p>}
      {hasMore && !searching && !problem && (
        <Button block onClick={() => void showMoreClips()}>
          Show more
        </Button>
      )}
    </>
  );
}

/** `wide` is the Media page, where there is room for more than two clips across. */
export function FreeClips({ wide }: { wide?: boolean }): ReactNode {
  const services = useClips((s) => s.services);
  const connected = useMemo(() => (services ?? []).filter((s) => s.connected), [services]);

  useEffect(() => {
    void loadClipServices();
  }, []);

  return (
    <div className={`free-clips${wide ? ' wide' : ''}`}>
      {!services ? (
        <div className="clip-wait">
          <Spinner />
        </div>
      ) : connected.length ? (
        <Browser services={connected} />
      ) : (
        <ConnectFirst services={services} />
      )}
    </div>
  );
}
