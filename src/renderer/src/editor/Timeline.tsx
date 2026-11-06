// The timeline: every element of the project, laid out in time and stacked in layers.
// Clips are positioned absolutely in one flat list, so moving a clip between tracks never remounts it.

import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Group,
  Image as ImageIcon,
  Link2,
  Music,
  Pause,
  Play,
  Plus,
  Scissors,
  Settings,
  StepBack,
  StepForward,
  Type,
  Ungroup,
  Video,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { durationSeconds, isActive, type AiJob } from '@shared/ai';
import { clamp, formatClock, formatTimecode, snapToFrame } from '@shared/time';
import {
  gapAt,
  type Gap,
  insertTrack,
  itemEnd,
  nearestFreeStart,
  projectDuration,
  rangeFree,
  snapClip,
  snapPoints,
  snapValue,
  trimEndTo,
  trimStartTo,
  updateItems,
} from '@shared/timeline';
import type { Asset, ID, Item, ProjectDoc } from '@shared/types';
import { isBeingReplaced } from '@/ai/clipActions';
import { openContextMenu, type MenuEntry } from '@/components/Menu';
import { Button, IconButton, Slider, Spinner } from '@/components/ui';
import { isMod, MOD_LABEL } from '@/lib/api';
import { trackPointer } from '@/lib/drag';
import { assetUrl } from '@/lib/media';
import {
  addAsset,
  apply,
  beginGesture,
  cancelGesture,
  clearSelection,
  deleteSelection,
  endGesture,
  groupSelection,
  hasClipboard,
  paste,
  select,
  selectGap,
  selectionHasGroup,
  selectItem,
  setPanel,
  setZoom,
  splitAtPlayhead,
  timelineEnd,
  ungroupSelection,
  useEditor,
  type Placement,
} from '@/store/editor';
import { useLibrary } from '@/store/library';
import { usePrefs, setPrefs } from '@/store/prefs';
import { downloadSection, itemMenu, selectionRange } from './actions';
import { ASSET_DRAG_TYPE, droppedPaths, hasFiles, importPathsIntoProject, pickIntoProjectAny } from './importing';
import { pause, seek, stepFrames, togglePlay } from './player';

const LEFT_PAD = 14;
const ROW_GAP = 4;
/** Height of the time ruler, which stays at the top while the rows scroll. */
const RULER = 26;
/** Empty band above and below the rows; dropping there creates a new track. */
const ZONE = 18;
const SNAP_PX = 8;
const VIEW_QUANTUM = 512;

// ---------------------------------------------------------------- row geometry

interface Rows {
  tops: Map<ID, number>;
  heights: Map<ID, number>;
  total: number;
}

function rowHeight(doc: ProjectDoc, trackId: ID): number {
  const items = doc.items.filter((it) => it.trackId === trackId);
  if (items.some((it) => it.type === 'video' || it.type === 'image')) return 52;
  if (items.length && items.every((it) => it.type === 'text')) return 30;
  return 40;
}

function layoutRows(doc: ProjectDoc): Rows {
  const tops = new Map<ID, number>();
  const heights = new Map<ID, number>();
  let y = 0;
  for (const t of doc.tracks) {
    const h = rowHeight(doc, t.id);
    tops.set(t.id, y);
    heights.set(t.id, h);
    y += h + ROW_GAP;
  }
  return { tops, heights, total: Math.max(0, y - ROW_GAP) };
}

/** Which row a y position (relative to the first row) falls on, or the band above or below all rows. */
function rowAtY(doc: ProjectDoc, rows: Rows, y: number): { index: number; zone: 'top' | 'bottom' | null } {
  if (y < -2) return { index: 0, zone: 'top' };
  if (y > rows.total + 2) return { index: doc.tracks.length - 1, zone: 'bottom' };
  for (let i = 0; i < doc.tracks.length; i++) {
    const id = doc.tracks[i].id;
    if (y < rows.tops.get(id)! + rows.heights.get(id)! + ROW_GAP / 2) return { index: i, zone: null };
  }
  return { index: doc.tracks.length - 1, zone: null };
}

// ---------------------------------------------------------------- clip pictures

function Filmstrip(props: { item: Item; asset: Asset; k: number; height: number; left: number; viewFrom: number; viewTo: number }): ReactNode {
  const { item, asset, k, height, left, viewFrom, viewTo } = props;
  const strip = asset.strip;
  if (!strip || item.type !== 'video') return null;
  const tw = (strip.tileW / strip.tileH) * height;
  const width = item.duration * k;
  const first = Math.max(0, Math.floor((viewFrom - left) / tw));
  const last = Math.min(Math.ceil(width / tw) - 1, Math.ceil((viewTo - left) / tw));
  const image = `url("${assetUrl(asset, 'strip')}")`;
  const tiles: ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    const t = item.trimStart + (((i + 0.5) * tw) / k) * item.speed;
    const index = clamp(Math.floor((t / asset.duration) * strip.count), 0, strip.count - 1);
    tiles.push(
      <div
        key={i}
        className="clip-tile"
        style={{ left: i * tw, width: tw, backgroundImage: image, backgroundSize: `${strip.count * tw}px ${height}px`, backgroundPositionX: -index * tw }}
      />,
    );
  }
  return <div className="clip-strip">{tiles}</div>;
}

function Wave({ item, asset, k, compact }: { item: Item; asset: Asset; k: number; compact: boolean }): ReactNode {
  if ((item.type !== 'audio' && item.type !== 'video') || !asset.hasWave) return null;
  return (
    <div
      className={`clip-wave${compact ? ' compact' : ''}`}
      style={{
        backgroundImage: `url("${assetUrl(asset, 'wave')}")`,
        backgroundSize: `${(asset.duration / item.speed) * k}px 100%`,
        backgroundPositionX: -(item.trimStart / item.speed) * k,
      }}
    />
  );
}

function clipLabel(item: Item, asset: Asset | undefined): string {
  if (item.type === 'text') return item.text.replace(/\s+/g, ' ').trim() || 'Empty text';
  return asset?.name ?? 'Media missing';
}

const KIND_ICON = {
  video: <Video size={12} />,
  image: <ImageIcon size={12} />,
  audio: <Music size={12} />,
  text: <Type size={12} />,
};

interface ClipProps {
  item: Item;
  asset: Asset | undefined;
  top: number;
  height: number;
  k: number;
  selected: boolean;
  /** An AI generation is on its way to take this element's place. */
  busy: boolean;
  waves: boolean;
  viewFrom: number;
  viewTo: number;
  onDown: (e: ReactPointerEvent, item: Item) => void;
  onTrim: (e: ReactPointerEvent, item: Item, edge: 'start' | 'end') => void;
  onMenu: (e: ReactMouseEvent, item: Item) => void;
}

const Clip = memo(function Clip(props: ClipProps): ReactNode {
  const { item, asset, top, height, k, selected, busy, waves, viewFrom, viewTo, onDown, onTrim, onMenu } = props;
  const left = LEFT_PAD + item.start * k;
  const width = Math.max(3, item.duration * k);
  const muted = (item.type === 'video' || item.type === 'audio') && item.muted;
  const label = clipLabel(item, asset);
  return (
    <div
      className={`clip ${item.type}${selected ? ' selected' : ''}`}
      style={{ left, top, width, height }}
      data-clip={item.id}
      title={`${label} · ${formatTimecode(item.duration)}`}
      onPointerDown={(e) => onDown(e, item)}
      onContextMenu={(e) => onMenu(e, item)}
    >
      {item.type === 'video' && asset && <Filmstrip item={item} asset={asset} k={k} height={height - 2} left={left} viewFrom={viewFrom} viewTo={viewTo} />}
      {item.type === 'image' && asset?.hasThumb && <div className="clip-picture" style={{ backgroundImage: `url("${assetUrl(asset, 'thumb')}")` }} />}
      {waves && asset && !muted && <Wave item={item} asset={asset} k={k} compact={item.type === 'video'} />}
      {width > 34 && (
        <div className="clip-label">
          {KIND_ICON[item.type]}
          {item.groupId && <Link2 size={12} />}
          {muted && <VolumeX size={12} />}
          <span className="truncate">{label}</span>
        </div>
      )}
      {busy && (
        <div className="clip-busy" title="AI is working on this clip">
          <Spinner /> AI
        </div>
      )}
      <div className="clip-trim start" onPointerDown={(e) => onTrim(e, item, 'start')} />
      <div className="clip-trim end" onPointerDown={(e) => onTrim(e, item, 'end')} />
    </div>
  );
});

/** Blocks on the timeline for generations that are still running, showing where they will land. */
function PendingBlocks({ jobs, doc, rows, k }: { jobs: AiJob[]; doc: ProjectDoc; rows: Rows; k: number }): ReactNode {
  const blocks: ReactNode[] = [];
  for (const job of jobs) {
    const p = job.request.placement;
    const chosen = job.request.choices.duration;
    const asked = (chosen !== undefined ? durationSeconds(chosen) : null) ?? 5;
    let trackId: ID | null;
    let start: number;
    let duration: number;
    if (p.kind === 'scene') {
      ({ trackId, start, duration } = p);
    } else if (p.kind === 'after') {
      const item = doc.items.find((it) => it.id === p.itemId);
      if (!item) continue;
      trackId = item.trackId;
      start = itemEnd(item);
      duration = asked;
    } else if (p.kind === 'timeline' && p.at !== undefined && !p.sequence) {
      // Its row may not exist yet, so it is marked in the band above the rows.
      trackId = null;
      start = p.at;
      duration = asked;
    } else continue;
    const top = trackId ? (rows.tops.get(trackId) ?? 0) : 1 - ZONE;
    const height = trackId ? (rows.heights.get(trackId) ?? 52) : ZONE - 2;
    blocks.push(
      <div key={job.id} className="tl-pending" style={{ left: LEFT_PAD + start * k, width: Math.max(4, duration * k), top, height }} title={job.prompt}>
        <Spinner /> <span className="truncate">{job.name}</span>
      </div>,
    );
  }
  return <>{blocks}</>;
}

// ---------------------------------------------------------------- ruler and playheads

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function tickStep(k: number): number {
  return TICK_STEPS.find((s) => s * k >= 70) ?? 7200;
}

function Ruler({ k, viewFrom, viewTo, width, onDown }: { k: number; viewFrom: number; viewTo: number; width: number; onDown: (e: ReactPointerEvent) => void }): ReactNode {
  const step = tickStep(k);
  const first = Math.max(0, Math.floor((viewFrom - LEFT_PAD) / k / step));
  const last = Math.ceil((viewTo - LEFT_PAD) / k / step);
  const labels: ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    const t = i * step;
    labels.push(
      <span key={i} className="tl-tick" style={{ left: LEFT_PAD + t * k }}>
        {step < 1 ? formatTimecode(t) : formatClock(t)}
      </span>,
    );
  }
  return (
    <div
      className="tl-ruler"
      style={{ width, backgroundSize: `${(step * k) / 5}px 5px`, backgroundPositionX: LEFT_PAD }}
      onPointerDown={onDown}
    >
      {labels}
    </div>
  );
}

function Playhead({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }): ReactNode {
  const t = useEditor((s) => s.playhead);
  const k = useEditor((s) => s.pxPerSec);
  const playing = useEditor((s) => s.playing);
  const x = LEFT_PAD + t * k;
  useEffect(() => {
    const el = scroller.current;
    if (!playing || !el) return;
    // Keep the playhead in view while playing, turning the page when it reaches the edge.
    if (x > el.scrollLeft + el.clientWidth - 24 || x < el.scrollLeft) el.scrollLeft = x - 40;
  }, [x, playing, scroller]);
  return (
    <div className="tl-playhead" style={{ transform: `translateX(${x}px)` }}>
      <div className="tl-playhead-cap" />
    </div>
  );
}

/** A faint line that follows the pointer and shows the time under it. */
function GhostPlayhead({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }): ReactNode {
  const [x, setX] = useState<number | null>(null);
  const k = useEditor((s) => s.pxPerSec);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const move = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      setX(Math.max(LEFT_PAD, e.clientX - r.left + el.scrollLeft));
    };
    const leave = (): void => setX(null);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [scroller]);
  if (x === null) return null;
  return (
    <div className="tl-ghost" style={{ transform: `translateX(${x}px)` }}>
      <span>{formatTimecode((x - LEFT_PAD) / k)}</span>
    </div>
  );
}

function TimeReadout(): ReactNode {
  const t = useEditor((s) => s.playhead);
  const doc = useEditor((s) => s.doc);
  return (
    <span className="tl-time tabular">
      {formatTimecode(t)} <span className="faint">/ {formatTimecode(doc ? projectDuration(doc) : 0)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- toolbar

function Toolbar({ onFit }: { onFit: () => void }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  const playing = useEditor((s) => s.playing);
  const k = useEditor((s) => s.pxPerSec);
  const range = selection.length ? selectionRange() : null;
  const empty = doc.items.length === 0;
  return (
    <div className="tl-toolbar">
      <div className="row grow">
        <Button variant="ghost" size="small" icon={<Scissors size={14} />} title="Split at the playhead (S)" disabled={empty} onClick={() => void splitAtPlayhead()}>
          Split
        </Button>
        {range && (
          <Button variant="ghost" size="small" icon={<Download size={14} />} title="Render only this part of the timeline" onClick={() => void downloadSection()}>
            Download section <span className="faint tabular">({formatClock(range.start)} – {formatClock(range.end)})</span>
          </Button>
        )}
        {selection.length > 1 && !selectionHasGroup(doc, selection) && (
          <Button variant="ghost" size="small" icon={<Group size={14} />} title={`Group (${MOD_LABEL}+G)`} onClick={groupSelection}>
            Group
          </Button>
        )}
        {selectionHasGroup(doc, selection) && (
          <Button variant="ghost" size="small" icon={<Ungroup size={14} />} onClick={ungroupSelection}>
            Ungroup
          </Button>
        )}
      </div>
      <div className="row">
        <IconButton label="Back one frame (Left arrow)" onClick={() => stepFrames(-1)} disabled={empty}>
          <StepBack size={16} />
        </IconButton>
        <button type="button" className="tl-play" aria-label={playing ? 'Pause (Space)' : 'Play (Space)'} title={playing ? 'Pause (Space)' : 'Play (Space)'} disabled={empty} onClick={togglePlay}>
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <IconButton label="Forward one frame (Right arrow)" onClick={() => stepFrames(1)} disabled={empty}>
          <StepForward size={16} />
        </IconButton>
        <TimeReadout />
      </div>
      <div className="row grow tl-toolbar-end">
        <IconButton label="Zoom out" onClick={() => setZoom(k / 1.4)}>
          <ZoomOut size={15} />
        </IconButton>
        <div className="tl-zoom">
          <Slider label="Timeline zoom" min={-1} max={9} step={0.05} value={Math.log2(k)} onChange={(v) => setZoom(2 ** v)} />
        </div>
        <IconButton label="Zoom in" onClick={() => setZoom(k * 1.4)}>
          <ZoomIn size={15} />
        </IconButton>
        <Button variant="ghost" size="small" title="Fit the whole project in view" disabled={empty} onClick={onFit}>
          Fit
        </Button>
        <IconButton label="Project settings" onClick={() => setPanel('settings')}>
          <Settings size={15} />
        </IconButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- timeline

export function Timeline({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  const selectedGap = useEditor((s) => s.gap);
  const k = useEditor((s) => s.pxPerSec);
  const snapTime = useEditor((s) => s.snapTime);
  const hint = useEditor((s) => s.newTrackHint);
  const reveal = useEditor((s) => s.reveal);
  const assets = useLibrary((s) => s.assetsById);
  const allJobs = useLibrary((s) => s.lib?.aiJobs);
  const projectJobs = useMemo(() => (allJobs ?? []).filter((j) => isActive(j) && j.request.target.projectId === projectId), [allJobs, projectId]);
  const showWaves = usePrefs((s) => s.showSoundwaves);
  const showGhost = usePrefs((s) => s.showGhostPlayhead);

  const scroller = useRef<HTMLDivElement>(null);
  const rowsEl = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const hadContent = useRef(false);
  const [view, setView] = useState({ from: 0, to: 2048, width: 1000 });
  const [hoverGap, setHoverGap] = useState<Gap | null>(null);

  const rows = layoutRows(doc);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const selected = new Set(selection);
  const end = timelineEnd(doc);
  const contentWidth = Math.max(view.width, LEFT_PAD + end * k + Math.max(240, view.width * 0.3));

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // Only the coarse position is tracked, so scrolling does not re-render clips on every pixel.
    const from = Math.floor(el.scrollLeft / VIEW_QUANTUM) * VIEW_QUANTUM - VIEW_QUANTUM;
    const to = Math.ceil((el.scrollLeft + el.clientWidth) / VIEW_QUANTUM) * VIEW_QUANTUM + VIEW_QUANTUM;
    setView((v) => (v.from === from && v.to === to && v.width === el.clientWidth ? v : { from, to, width: el.clientWidth }));
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scroller.current) {
      scroller.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
    measure();
  }, [k, measure]);

  const fit = useCallback(() => {
    const el = scroller.current;
    const d = useEditor.getState().doc;
    if (!el || !d) return;
    setZoom((el.clientWidth - LEFT_PAD - 48) / Math.max(1, timelineEnd(d)));
    // Set now as well as after the zoom lands: when the zoom does not change, nothing re-renders.
    el.scrollLeft = 0;
    pendingScroll.current = 0;
  }, []);

  // Show the whole project when it is opened or when its first clip arrives.
  useEffect(() => {
    if (doc.items.length && !hadContent.current) fit();
    hadContent.current = doc.items.length > 0;
  }, [doc.items.length, fit]);

  // A clip that lands out of sight is scrolled to, so it cannot go unnoticed.
  useEffect(() => {
    const el = scroller.current;
    const s = useEditor.getState();
    const item = reveal && s.doc?.items.find((it) => it.id === reveal.id);
    if (!el || !item) return;
    const left = LEFT_PAD + item.start * s.pxPerSec;
    const right = left + item.duration * s.pxPerSec;
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - 40);
    const top = RULER + ZONE + (rowsRef.current.tops.get(item.trackId) ?? 0);
    const bottom = top + (rowsRef.current.heights.get(item.trackId) ?? 0);
    if (top < el.scrollTop + RULER) el.scrollTop = top - RULER - ZONE;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight + ROW_GAP;
  }, [reveal]);

  // Ctrl/Cmd + wheel zooms around the pointer. This needs a non-passive listener.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!isMod(e)) return;
      e.preventDefault();
      const current = useEditor.getState().pxPerSec;
      const px = e.clientX - el.getBoundingClientRect().left;
      const t = (px + el.scrollLeft - LEFT_PAD) / current;
      const next = clamp(current * Math.exp(-e.deltaY * 0.002), 0.5, 600);
      pendingScroll.current = LEFT_PAD + t * next - px;
      setZoom(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const timeAt = useCallback((clientX: number): number => {
    const el = scroller.current!;
    const s = useEditor.getState();
    const t = (clientX - el.getBoundingClientRect().left + el.scrollLeft - LEFT_PAD) / s.pxPerSec;
    return Math.max(0, snapToFrame(t, s.doc!.settings.fps));
  }, []);

  const rowHit = useCallback((clientY: number): { index: number; zone: 'top' | 'bottom' | null } => {
    const y = clientY - rowsEl.current!.getBoundingClientRect().top;
    return rowAtY(useEditor.getState().doc!, rowsRef.current, y);
  }, []);

  /** Scrolls when a drag reaches the left or right edge of the timeline. */
  const edgeScroll = (clientX: number): void => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    if (clientX > r.right - 36) el.scrollLeft += 16;
    else if (clientX < r.left + 36) el.scrollLeft -= 16;
  };

  // ---- moving clips

  const onClipDown = useCallback(
    (e: ReactPointerEvent, item: Item): void => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const additive = isMod(e) || e.shiftKey;
      if (additive) {
        selectItem(item.id, true);
        return;
      }
      if (!useEditor.getState().selection.includes(item.id)) selectItem(item.id, false);
      else select(useEditor.getState().selection);

      const state = useEditor.getState();
      const base = state.doc!;
      const ids = new Set(state.selection);
      const moved = base.items.filter((it) => ids.has(it.id));
      const others: ProjectDoc = { ...base, items: base.items.filter((it) => !ids.has(it.id)) };
      const rowOf = new Map(base.tracks.map((t, i) => [t.id, i]));
      const rowIndexes = moved.map((m) => rowOf.get(m.trackId)!);
      const minRow = Math.min(...rowIndexes);
      const maxRow = Math.max(...rowIndexes);
      const minStart = Math.min(...moved.map((m) => m.start));
      const maxEnd = Math.max(...moved.map(itemEnd));
      const points = snapPoints(base, ids, [state.playhead]);
      const startRow = rowOf.get(item.trackId)!;
      const grabOffset = e.clientX;
      const el = scroller.current!;
      const scrollStart = el.scrollLeft;
      let started = false;
      let zone: 'top' | 'bottom' | null = null;

      trackPointer(
        (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - grabOffset) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
            started = true;
            beginGesture();
          }
          edgeScroll(ev.clientX);
          const s = useEditor.getState();
          const dt = (ev.clientX - grabOffset + el.scrollLeft - scrollStart) / s.pxPerSec;

          const hit = rowHit(ev.clientY);
          zone = minRow === maxRow ? hit.zone : null;
          const dRow = clamp(hit.index - startRow, -minRow, base.tracks.length - 1 - maxRow);
          const rowShift = hit.zone ? 0 : dRow;
          const target = (m: Item): ID => base.tracks[rowOf.get(m.trackId)! + rowShift].id;

          const threshold = ev.altKey ? 0 : SNAP_PX / s.pxPerSec;
          const snapped = snapClip(Math.max(0, minStart + dt), maxEnd - minStart, points, threshold);
          let delta = Math.max(0, snapped.start) - minStart;
          // A new row is empty, so what is on the clip's current row must not push it around.
          const fits = !!zone || moved.every((m) => rangeFree(others, target(m), m.start + delta, itemEnd(m) + delta));
          if (!fits) {
            // A single clip slides to the nearest free spot. A selection stays where it last fitted.
            if (moved.length > 1) return;
            delta = nearestFreeStart(others, target(moved[0]), moved[0].start + delta, moved[0].duration) - moved[0].start;
          }
          apply(() => ({
            ...base,
            items: base.items.map((it) => (ids.has(it.id) ? ({ ...it, start: it.start + delta, trackId: target(it) } as Item) : it)),
          }));
          useEditor.setState({ snapTime: fits ? snapped.hit : null, newTrackHint: zone });
        },
        (_ev, cancelled) => {
          if (!started) return;
          if (cancelled) {
            cancelGesture();
            return;
          }
          if (zone) {
            const where = zone;
            apply((d) => {
              const made = insertTrack(d, where === 'top' ? 0 : d.tracks.length);
              return updateItems(made.doc, ids, (it) => ({ ...it, trackId: made.trackId }) as Item);
            });
          }
          endGesture({ snapToFrames: true });
        },
      );
    },
    [rowHit],
  );

  // ---- trimming

  const onTrim = useCallback((e: ReactPointerEvent, item: Item, edge: 'start' | 'end'): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectItem(item.id, false);
    const state = useEditor.getState();
    const base = state.doc!;
    const original = base.items.find((it) => it.id === item.id)!;
    const asset = original.type === 'text' ? undefined : useLibrary.getState().assetsById[original.assetId];
    const points = snapPoints(base, new Set([item.id]), [state.playhead]);
    const startX = e.clientX;
    const el = scroller.current!;
    const scrollStart = el.scrollLeft;
    let started = false;

    trackPointer(
      (ev) => {
        if (!started) {
          started = true;
          beginGesture();
        }
        edgeScroll(ev.clientX);
        const s = useEditor.getState();
        const dt = (ev.clientX - startX + el.scrollLeft - scrollStart) / s.pxPerSec;
        const wanted = edge === 'start' ? original.start + dt : itemEnd(original) + dt;
        const snapped = snapValue(wanted, points, ev.altKey ? 0 : SNAP_PX / s.pxPerSec);
        const next = edge === 'start' ? trimStartTo(base, original, snapped.value) : trimEndTo(base, original, snapped.value, asset);
        apply(() => updateItems(base, [item.id], () => next));
        useEditor.setState({ snapTime: snapped.hit });
      },
      (_ev, cancelled) => {
        if (!started) return;
        if (cancelled) cancelGesture();
        else endGesture({ snapToFrames: true });
      },
    );
  }, []);

  const onClipMenu = useCallback(
    (e: ReactMouseEvent, item: Item): void => {
      if (!useEditor.getState().selection.includes(item.id)) selectItem(item.id, false);
      openContextMenu(e, itemMenu(item, projectId));
    },
    [projectId],
  );

  // ---- empty space and the ruler

  const gapUnder = (clientX: number, clientY: number): Gap | null => {
    const hit = rowHit(clientY);
    return hit.zone ? null : gapAt(useEditor.getState().doc!, doc.tracks[hit.index].id, timeAt(clientX));
  };

  const onBackgroundDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0 || !rowsEl.current) return;
    const gap = gapUnder(e.clientX, e.clientY);
    if (gap) selectGap(gap);
    else clearSelection();
    pause();
    seek(timeAt(e.clientX));
  };

  const onBackgroundMenu = (e: ReactMouseEvent): void => {
    const gap = gapUnder(e.clientX, e.clientY);
    const at = timeAt(e.clientX);
    const entries: MenuEntry[] = [
      gap && {
        label: 'Delete empty space',
        hint: 'Del',
        onSelect: () => {
          selectGap(gap);
          deleteSelection();
        },
      },
      { label: 'Paste here', disabled: !hasClipboard(), onSelect: () => paste(at) },
    ];
    openContextMenu(e, entries);
  };

  const onHover = (e: ReactPointerEvent): void => {
    const onClip = (e.target as HTMLElement).closest('.clip');
    const gap = onClip ? null : gapUnder(e.clientX, e.clientY);
    setHoverGap((g) => (g?.trackId === gap?.trackId && g?.start === gap?.start && g?.end === gap?.end ? g : gap));
  };

  const onRulerDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return;
    pause();
    seek(timeAt(e.clientX));
    trackPointer(
      (ev) => {
        edgeScroll(ev.clientX);
        seek(timeAt(ev.clientX));
      },
      () => undefined,
    );
  };

  // ---- dropping media

  const placementAt = (e: ReactDragEvent): Placement => {
    const hit = rowHit(e.clientY);
    const at = timeAt(e.clientX);
    if (!doc.items.length) return { at: 0 };
    return hit.zone ? { newTrack: hit.zone, at } : { trackId: doc.tracks[hit.index].id, at };
  };

  const accepts = (e: ReactDragEvent): boolean => hasFiles(e.dataTransfer) || [...e.dataTransfer.types].includes(ASSET_DRAG_TYPE);

  const onDragOver = (e: ReactDragEvent): void => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    const zone = doc.items.length ? rowHit(e.clientY).zone : null;
    if (zone !== useEditor.getState().newTrackHint) useEditor.setState({ newTrackHint: zone });
  };

  const onDrop = (e: ReactDragEvent): void => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    useEditor.setState({ newTrackHint: null });
    const where = placementAt(e);
    const assetId = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (assetId) {
      const asset = useLibrary.getState().assetsById[assetId];
      if (asset) addAsset(asset, where);
      return;
    }
    void importPathsIntoProject(droppedPaths(e.dataTransfer), projectId, true, where);
  };

  const gapBlock = (gap: Gap, kind: 'hover' | 'selected'): ReactNode => {
    const top = rows.tops.get(gap.trackId);
    if (top === undefined) return null;
    return (
      <div
        key={kind}
        className={`tl-gap ${kind}`}
        style={{ left: LEFT_PAD + gap.start * k, width: (gap.end - gap.start) * k, top, height: rows.heights.get(gap.trackId) }}
      >
        {kind === 'selected' && (gap.end - gap.start) * k > 110 && <span>Press Delete to close this gap</span>}
      </div>
    );
  };

  const projectEnd = doc.settings.durationMode === 'fixed' ? projectDuration(doc) : null;

  return (
    <div className="timeline">
      <Toolbar onFit={fit} />
      <div
        ref={scroller}
        className="tl-scroll"
        onScroll={measure}
        onDragOver={onDragOver}
        onDragLeave={() => useEditor.setState({ newTrackHint: null })}
        onDrop={onDrop}
      >
        <div className="tl-content" style={{ width: contentWidth }}>
          <Ruler k={k} viewFrom={view.from} viewTo={view.to} width={contentWidth} onDown={onRulerDown} />
          <div className="tl-body" onPointerDown={onBackgroundDown} onContextMenu={onBackgroundMenu} onPointerMove={onHover} onPointerLeave={() => setHoverGap(null)}>
            <div className={`tl-new-track${hint === 'top' ? ' active' : ''}`} style={{ height: ZONE }} />
            <div ref={rowsEl} className="tl-rows" style={{ height: Math.max(rows.total, 40) }}>
              {doc.tracks.map((t) => (
                <div key={t.id} className="tl-row" style={{ top: rows.tops.get(t.id), height: rows.heights.get(t.id) }} />
              ))}
              {hoverGap && !(selectedGap && hoverGap.trackId === selectedGap.trackId && hoverGap.start === selectedGap.start) && gapBlock(hoverGap, 'hover')}
              {selectedGap && gapBlock(selectedGap, 'selected')}
              {doc.items.map((it) => (
                <Clip
                  key={it.id}
                  item={it}
                  asset={it.type === 'text' ? undefined : assets[it.assetId]}
                  top={rows.tops.get(it.trackId) ?? 0}
                  height={rows.heights.get(it.trackId) ?? 40}
                  k={k}
                  selected={selected.has(it.id)}
                  busy={isBeingReplaced(projectJobs, it)}
                  waves={showWaves}
                  viewFrom={view.from}
                  viewTo={view.to}
                  onDown={onClipDown}
                  onTrim={onTrim}
                  onMenu={onClipMenu}
                />
              ))}
              <PendingBlocks jobs={projectJobs} doc={doc} rows={rows} k={k} />
              {!doc.items.length && !projectJobs.length && (
                <button
                  type="button"
                  className="tl-add-media"
                  style={{ left: LEFT_PAD }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void pickIntoProjectAny(projectId)}
                >
                  <Plus size={14} /> Add media to this project
                </button>
              )}
            </div>
            <div className={`tl-new-track${hint === 'bottom' ? ' active' : ''}`} style={{ height: ZONE }} />
          </div>
          {snapTime !== null && <div className="tl-snap" style={{ transform: `translateX(${LEFT_PAD + snapTime * k}px)` }} />}
          {projectEnd !== null && <div className="tl-project-end" style={{ left: LEFT_PAD + projectEnd * k }} title="End of the project" />}
          {showGhost && <GhostPlayhead scroller={scroller} />}
          <Playhead scroller={scroller} />
        </div>
      </div>
    </div>
  );
}

/** The line above the timeline: dragging it makes the timeline taller or shorter. */
export function TimelineResizer(): ReactNode {
  const onDown = (e: ReactPointerEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = usePrefs.getState().timelineHeight;
    document.body.classList.add('resizing-row');
    trackPointer(
      (ev) => setPrefs({ timelineHeight: clamp(startH + startY - ev.clientY, 150, window.innerHeight - 260) }),
      () => document.body.classList.remove('resizing-row'),
    );
  };
  return <div className="tl-resizer" role="separator" aria-orientation="horizontal" aria-label="Resize the timeline" onPointerDown={onDown} />;
}
