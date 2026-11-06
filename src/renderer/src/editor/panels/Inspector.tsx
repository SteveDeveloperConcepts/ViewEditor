// The panel on the right while a clip is selected: everything that can be changed about it.

import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AudioLines,
  Bold,
  CaseUpper,
  CircleAlert,
  Group,
  Italic,
  Maximize,
  Minimize,
  Replace,
  Sparkles,
  Trash2,
  Undo2,
  Ungroup,
  X,
} from 'lucide-react';
import { FONT_FAMILIES } from '@shared/constants';
import { formatClock } from '@shared/time';
import { isTimed, itemEnd, nearestFreeStart, setSourceRange, trimEndTo, updateItems } from '@shared/timeline';
import type { Asset, ID, Item, MediaItem, ProjectDoc, TextItem, TextStyle } from '@shared/types';
import { Button, ColorField, FieldRow, IconButton, Notice, NumberInput, Segmented, Slider, Switch, TimeInput } from '@/components/ui';
import { actionLabel, actionsFor, openClipAi } from '@/ai/clipActions';
import { openConnections } from '@/ai/ConnectionsDialog';
import { useConnected } from '@/store/ai';
import {
  apply,
  clearSelection,
  deleteSelection,
  fitItem,
  groupSelection,
  restoreOriginal,
  selectionHasGroup,
  setSpeed,
  ungroupSelection,
  updateItem,
  updateText,
  useEditor,
} from '@/store/editor';
import { useLibrary } from '@/store/library';
import { extractAudioFrom, replaceMediaFor } from '../actions';

const SPEEDS = ['0.5', '1', '1.5', '2'];

/** Moving a clip and trimming it are different things, so they get a section each. */
function Timing({ item, asset }: { item: Item; asset: Asset | undefined }): ReactNode {
  const change = (next: (doc: ProjectDoc, current: Item) => Item): void => {
    apply((doc) => {
      const current = doc.items.find((it) => it.id === item.id);
      return current ? updateItems(doc, [item.id], () => next(doc, current)) : doc;
    });
  };
  return (
    <>
      <section>
        <h3>Position</h3>
        <label className="field">
          <span className="label">Starts at</span>
          <TimeInput
            label="Starts at"
            value={item.start}
            onCommit={(t) => change((doc, it) => ({ ...it, start: nearestFreeStart(doc, it.trackId, Math.max(0, t), it.duration, new Set([it.id])) }) as Item)}
          />
          <span className="hint">Moves the whole clip along the timeline.</span>
        </label>
      </section>
      {isTimed(item) ? (
        <section>
          <h3>Trim</h3>
          <div className="form-grid">
            <label className="field">
              <span className="label">Plays from</span>
              <TimeInput
                label="Plays from"
                value={item.trimStart}
                onCommit={(t) => change((doc, it) => (isTimed(it) ? setSourceRange(doc, it, t, it.trimStart + it.duration * it.speed, asset) : it))}
              />
            </label>
            <label className="field">
              <span className="label">To</span>
              <TimeInput
                label="Plays to"
                value={item.trimStart + item.duration * item.speed}
                onCommit={(t) => change((doc, it) => (isTimed(it) ? setSourceRange(doc, it, it.trimStart, t, asset) : it))}
              />
            </label>
          </div>
          <span className="hint">Which part of the file this clip plays. Nothing is deleted.</span>
        </section>
      ) : (
        <section>
          <h3>Length</h3>
          <TimeInput label="Length" value={item.duration} onCommit={(t) => change((doc, it) => trimEndTo(doc, it, it.start + t, asset))} />
        </section>
      )}
    </>
  );
}

/** Text or a picture that outlasts the footage makes the video longer, which is easy to miss. */
function PastTheEnd({ item, doc }: { item: Item; doc: ProjectDoc }): ReactNode {
  if (item.type !== 'text' && item.type !== 'image') return null;
  const footage = doc.items.filter(isTimed);
  if (!footage.length) return null;
  const end = Math.max(...footage.map(itemEnd));
  const over = itemEnd(item) - end;
  if (over < 0.05 || end <= item.start) return null;
  return (
    <Notice kind="warning" icon={<CircleAlert size={15} />}>
      This runs {over.toFixed(1)} s past the end of your video, which makes the video longer.{' '}
      <button type="button" className="link-btn inline" onClick={() => updateItem(item.id, { duration: end - item.start })}>
        End with the video
      </button>
    </Notice>
  );
}

function Opacity({ item }: { item: Exclude<Item, { type: 'audio' }> }): ReactNode {
  return (
    <div className="field">
      <span className="label">Opacity · {Math.round(item.opacity * 100)}%</span>
      <Slider label="Opacity" min={0} max={1} step={0.01} value={item.opacity} onChange={(opacity) => updateItem(item.id, { opacity }, 'opacity')} />
    </div>
  );
}

function AudioControls({ item, asset }: { item: MediaItem; asset: Asset | undefined }): ReactNode {
  const preset = SPEEDS.find((s) => Number(s) === item.speed);
  const silent = asset ? !asset.hasAudio : false;
  return (
    <>
      <section>
        <h3>Speed</h3>
        <Segmented<string>
          fill
          label="Playback speed"
          value={preset ?? 'custom'}
          options={[...SPEEDS.map((s) => ({ value: s, label: `${s}x` })), ...(preset ? [] : [{ value: 'custom', label: `${item.speed}x` }])]}
          onChange={(v) => {
            if (v !== 'custom') setSpeed(item.id, Number(v));
          }}
        />
        <FieldRow label="Custom">
          <div className="fixed">
            <NumberInput label="Custom speed" min={0.25} max={4} decimals={2} value={item.speed} onCommit={(v) => setSpeed(item.id, v)} />
          </div>
        </FieldRow>
      </section>
      {silent ? (
        <p className="faint panel-note">This clip has no sound.</p>
      ) : (
        <section>
          <h3>Audio</h3>
          <div className="field">
            <span className="label">Volume · {Math.round(item.volume * 100)}%</span>
            <Slider label="Volume" min={0} max={1} step={0.01} value={item.volume} onChange={(volume) => updateItem(item.id, { volume }, 'volume')} />
          </div>
          <FieldRow label="Mute">
            <Switch label="Mute" checked={item.muted} onChange={(muted) => updateItem(item.id, { muted })} />
          </FieldRow>
          <FieldRow label="Fade audio in/out">
            <Switch label="Fade audio in and out" checked={item.fadeAudio} onChange={(fadeAudio) => updateItem(item.id, { fadeAudio })} />
          </FieldRow>
          {item.type === 'video' && (
            <Button size="small" icon={<AudioLines size={13} />} onClick={() => void extractAudioFrom(item)}>
              Extract audio
            </Button>
          )}
        </section>
      )}
    </>
  );
}

function PictureControls({ item }: { item: Extract<Item, { type: 'video' | 'image' }> }): ReactNode {
  return (
    <section>
      <h3>Picture</h3>
      <div className="panel-actions">
        <Button size="small" icon={<Minimize size={13} />} title="Show the whole picture inside the frame" onClick={() => fitItem(item.id, 'contain')}>
          Fit
        </Button>
        <Button size="small" icon={<Maximize size={13} />} title="Cover the whole frame" onClick={() => fitItem(item.id, 'cover')}>
          Fill
        </Button>
      </div>
      <Opacity item={item} />
    </section>
  );
}

function TextControls({ item }: { item: TextItem }): ReactNode {
  const kits = useLibrary((s) => s.lib?.brandKits) ?? [];
  const input = useRef<HTMLTextAreaElement>(null);
  const style = (patch: Partial<TextStyle>, coalesce?: string): void => updateText(item.id, { style: patch }, coalesce);
  const s = item.style;
  const brandFonts = kits.flatMap((k) => k.fonts.map((f) => f.family));
  const fonts = [...new Set([...brandFonts, ...FONT_FAMILIES, s.fontFamily])];

  useEffect(() => {
    const focus = (): void => {
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('vieweditor:edit-text', focus);
    return () => window.removeEventListener('vieweditor:edit-text', focus);
  }, []);

  return (
    <>
      <section>
        <h3>{item.subtitle ? 'Subtitle' : 'Text'}</h3>
        <textarea ref={input} className="textarea" rows={3} aria-label="Text" value={item.text} onChange={(e) => updateText(item.id, { text: e.target.value }, 'text')} />
      </section>
      <section>
        <h3>Font</h3>
        <select className="select" aria-label="Font" value={s.fontFamily} onChange={(e) => style({ fontFamily: e.target.value })}>
          {fonts.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <div className="row">
          <div className="size-box">
            <NumberInput label="Font size" min={6} max={800} value={s.fontSize} onCommit={(fontSize) => style({ fontSize })} />
          </div>
          <IconButton label="Bold" active={s.bold} onClick={() => style({ bold: !s.bold })}>
            <Bold size={15} />
          </IconButton>
          <IconButton label="Italic" active={s.italic} onClick={() => style({ italic: !s.italic })}>
            <Italic size={15} />
          </IconButton>
          <IconButton label="All capitals" active={s.uppercase} onClick={() => style({ uppercase: !s.uppercase })}>
            <CaseUpper size={15} />
          </IconButton>
        </div>
        <Segmented<TextStyle['align']>
          fill
          label="Alignment"
          value={s.align}
          options={[
            { value: 'left', label: <AlignLeft size={14} />, title: 'Left' },
            { value: 'center', label: <AlignCenter size={14} />, title: 'Centre' },
            { value: 'right', label: <AlignRight size={14} />, title: 'Right' },
          ]}
          onChange={(align) => style({ align })}
        />
      </section>
      <section>
        <h3>Colour</h3>
        <ColorField label="Text colour" value={s.color} onChange={(color) => style({ color }, 'text-color')} />
        <FieldRow label="Background">
          <Switch label="Text background" checked={!!s.bgColor} onChange={(on) => style({ bgColor: on ? '#000000' : null })} />
        </FieldRow>
        {s.bgColor && <ColorField label="Text background colour" value={s.bgColor} onChange={(bgColor) => style({ bgColor }, 'text-bg')} />}
        <FieldRow label="Outline">
          <Switch label="Text outline" checked={!!s.strokeColor} onChange={(on) => style({ strokeColor: on ? '#000000' : null })} />
        </FieldRow>
        {s.strokeColor && <ColorField label="Outline colour" value={s.strokeColor} onChange={(strokeColor) => style({ strokeColor }, 'text-stroke')} />}
        <FieldRow label="Shadow">
          <Switch label="Text shadow" checked={s.shadow} onChange={(shadow) => style({ shadow })} />
        </FieldRow>
        <Opacity item={item} />
      </section>
    </>
  );
}

const TITLES = { video: 'Video', image: 'Image', audio: 'Audio', text: 'Text' };

export function Inspector({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  const assets = useLibrary((s) => s.assetsById);
  const connected = useConnected();
  const items = doc.items.filter((it) => selection.includes(it.id));

  if (items.length !== 1) {
    const grouped = selectionHasGroup(doc, selection);
    return (
      <div className="panel-body">
        <div className="inspector-head">
          <h2 className="panel-title grow">{items.length} clips</h2>
          <IconButton label="Close clip settings" onClick={clearSelection}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="panel-actions">
          {grouped ? (
            <Button icon={<Ungroup size={14} />} onClick={ungroupSelection}>
              Ungroup
            </Button>
          ) : (
            <Button icon={<Group size={14} />} onClick={groupSelection}>
              Group
            </Button>
          )}
          <Button icon={<Trash2 size={14} />} onClick={deleteSelection}>
            Delete
          </Button>
        </div>
        <p className="faint panel-note">Grouped clips move together on the timeline and in the picture.</p>
      </div>
    );
  }

  const item = items[0];
  const asset = item.type === 'text' ? undefined : assets[item.assetId];
  return (
    <div className="panel-body">
      <div className="inspector-head">
        <h2 className="panel-title grow truncate" title={asset?.name}>
          {item.type === 'text' ? (item.subtitle ? 'Subtitle' : 'Text') : (asset?.name ?? TITLES[item.type])}
        </h2>
        <IconButton label="Delete" onClick={deleteSelection}>
          <Trash2 size={15} />
        </IconButton>
        <IconButton label="Close clip settings" onClick={clearSelection}>
          <X size={16} />
        </IconButton>
      </div>
      {asset && (
        <p className="faint panel-note tabular">
          {asset.kind === 'audio' ? `${formatClock(asset.duration)} · ${asset.audioCodec ?? 'audio'}` : `${asset.width} × ${asset.height}${asset.kind === 'video' ? ` · ${formatClock(asset.duration)} · ${asset.fps} fps` : ''}`}
          {asset.isHdr && ' · HDR converted to SDR'}
        </p>
      )}
      <PastTheEnd item={item} doc={doc} />
      {actionsFor(item).length > 0 && (
        <section>
          <h3>AI</h3>
          {actionsFor(item).map((action) => (
            <Button key={action} size="small" icon={<Sparkles size={13} />} onClick={() => (connected ? openClipAi(item, action) : openConnections())}>
              {actionLabel(action)}
            </Button>
          ))}
          {(item.type === 'video' || item.type === 'image') && item.restore && (
            <Button size="small" icon={<Undo2 size={13} />} onClick={() => restoreOriginal(item.id)}>
              Restore original
            </Button>
          )}
        </section>
      )}
      {item.type === 'text' && <TextControls item={item} />}
      {(item.type === 'video' || item.type === 'image') && <PictureControls item={item} />}
      {isTimed(item) && <AudioControls item={item} asset={asset} />}
      <Timing item={item} asset={asset} />
      {item.type !== 'text' && (
        <Button size="small" icon={<Replace size={13} />} onClick={() => void replaceMediaFor(item)}>
          Replace media
        </Button>
      )}
      {asset?.origin?.prompt && (
        <section>
          <h3>Generated by {asset.origin.model}</h3>
          <p className="faint panel-note selectable">{asset.origin.prompt}</p>
        </section>
      )}
    </div>
  );
}
