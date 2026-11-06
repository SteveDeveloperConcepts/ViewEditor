// The canvas: a live preview of the frame under the playhead. Elements can be clicked to select,
// dragged to move and resized by their handles; they snap to the centre and edges of the frame.

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ImageOff, Upload } from 'lucide-react';
import { isVisual, scaleTextStyle, updateItems } from '@shared/timeline';
import type { Asset, AudioItem, ID, ImageItem, Item, TextItem, VideoItem, VisualItem } from '@shared/types';
import { isMod } from '@/lib/api';
import { trackPointer } from '@/lib/drag';
import { assetUrl } from '@/lib/media';
import { drawTextItem, textBleed, textHeight } from '@/lib/textRender';
import { Spinner } from '@/components/ui';
import { apply, beginGesture, cancelGesture, clearSelection, endGesture, selectItem, useEditor, type EditorState } from '@/store/editor';
import { useLibrary } from '@/store/library';
import { droppedPaths, hasFiles, importPathsIntoProject } from './importing';
import { registerMedia, registerVisual } from './player';

/** Elements are kept in the page only while the playhead is near them, so long projects stay light. */
function mountedKey(s: EditorState): string {
  if (!s.doc) return '';
  const t = s.playhead;
  const ids: string[] = [];
  for (const it of s.doc.items) if (t >= it.start - 4 && t <= it.start + it.duration + 1) ids.push(it.id);
  return ids.join(',');
}

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'w' | 'e';

interface LayerProps<T> {
  item: T;
  asset: Asset | undefined;
  scale: number;
  z: number;
  onDown: (e: ReactPointerEvent, item: VisualItem) => void;
}

function boxStyle(item: VisualItem, scale: number, z: number): CSSProperties {
  return {
    left: item.x * scale,
    top: item.y * scale,
    width: item.w * scale,
    height: item.h * scale,
    opacity: item.opacity,
    zIndex: z,
    visibility: 'hidden',
  };
}

function Placeholder(props: { item: VisualItem; scale: number; z: number; asset: Asset | undefined; onDown: LayerProps<VisualItem>['onDown']; children: ReactNode }): ReactNode {
  const { item, scale, z, asset, onDown, children } = props;
  const ref = useCallback((el: HTMLDivElement | null) => registerVisual(item.id, el), [item.id]);
  return (
    <div ref={ref} className="stage-placeholder" style={boxStyle(item, scale, z)} onPointerDown={(e) => onDown(e, item)}>
      {asset?.hasThumb && <img src={assetUrl(asset, 'thumb')} alt="" draggable={false} />}
      <div className="stage-placeholder-note">{children}</div>
    </div>
  );
}

const VideoLayer = memo(function VideoLayer({ item, asset, scale, z, onDown }: LayerProps<VideoItem>): ReactNode {
  const ref = useCallback(
    (el: HTMLVideoElement | null) => {
      registerMedia(item.id, el);
      registerVisual(item.id, el);
    },
    [item.id],
  );
  if (!asset) {
    return (
      <Placeholder item={item} scale={scale} z={z} asset={asset} onDown={onDown}>
        <ImageOff size={18} /> Media missing
      </Placeholder>
    );
  }
  if (asset.proxy === 'pending') {
    return (
      <Placeholder item={item} scale={scale} z={z} asset={asset} onDown={onDown}>
        <Spinner /> Preparing preview…
      </Placeholder>
    );
  }
  return (
    <video
      ref={ref}
      className="stage-layer"
      src={assetUrl(asset, 'preview')}
      style={boxStyle(item, scale, z)}
      preload="auto"
      playsInline
      crossOrigin="anonymous"
      disablePictureInPicture
      tabIndex={-1}
      onPointerDown={(e) => onDown(e, item)}
    />
  );
});

const ImageLayer = memo(function ImageLayer({ item, asset, scale, z, onDown }: LayerProps<ImageItem>): ReactNode {
  const ref = useCallback((el: HTMLImageElement | null) => registerVisual(item.id, el), [item.id]);
  if (!asset) {
    return (
      <Placeholder item={item} scale={scale} z={z} asset={asset} onDown={onDown}>
        <ImageOff size={18} /> Media missing
      </Placeholder>
    );
  }
  return (
    <img
      ref={ref}
      className="stage-layer"
      src={assetUrl(asset, 'original')}
      alt=""
      draggable={false}
      crossOrigin="anonymous"
      style={boxStyle(item, scale, z)}
      onPointerDown={(e) => onDown(e, item)}
    />
  );
});

const TextLayer = memo(function TextLayer({ item, scale, z, onDown, fontTick }: LayerProps<TextItem> & { fontTick: number }): ReactNode {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const ref = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvas.current = el;
      registerVisual(item.id, el);
    },
    [item.id],
  );
  const bleed = textBleed(item.style);
  const dpr = window.devicePixelRatio || 1;
  const cssW = (item.w + bleed * 2) * scale;
  const cssH = (item.h + bleed * 2) * scale;

  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.width = Math.max(1, Math.round(cssW * dpr));
    el.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = el.getContext('2d')!;
    ctx.clearRect(0, 0, el.width, el.height);
    // Opacity is applied by CSS here; the exporter bakes it into the pixels instead.
    drawTextItem(ctx, { ...item, opacity: 1 }, scale * dpr, item.x - bleed, item.y - bleed);
  }, [item, scale, dpr, cssW, cssH, bleed, fontTick]);

  return (
    <canvas
      ref={ref}
      className="stage-layer"
      style={{
        left: (item.x - bleed) * scale,
        top: (item.y - bleed) * scale,
        width: cssW,
        height: cssH,
        opacity: item.opacity,
        zIndex: z,
        visibility: 'hidden',
      }}
      onPointerDown={(e) => onDown(e, item)}
      onDoubleClick={() => window.dispatchEvent(new CustomEvent('vieweditor:edit-text'))}
    />
  );
});

const AudioLayer = memo(function AudioLayer({ item, asset }: { item: VideoItem | AudioItem; asset: Asset | undefined }): ReactNode {
  const ref = useCallback((el: HTMLAudioElement | null) => registerMedia(item.id, el), [item.id]);
  if (!asset || asset.proxy === 'pending') return null;
  return <audio ref={ref} src={assetUrl(asset, 'preview')} preload="auto" crossOrigin="anonymous" />;
});

export function Stage({ projectId }: { projectId: ID }): ReactNode {
  const doc = useEditor((s) => s.doc)!;
  const selection = useEditor((s) => s.selection);
  const key = useEditor(mountedKey);
  const playhead = useEditor((s) => (s.playing ? -1 : s.playhead));
  const assets = useLibrary((s) => s.assetsById);
  const wrap = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ w: 800, h: 450 });
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [fontTick, setFontTick] = useState(0);
  const [dropping, setDropping] = useState(false);
  // The pointer handlers are created once; they read the current scale through this ref.
  const scaleRef = useRef(1);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = (): void => setArea({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Text is drawn on canvases, so it has to be redrawn when a font finishes loading.
  useEffect(() => {
    const bump = (): void => setFontTick((n) => n + 1);
    document.fonts.addEventListener('loadingdone', bump);
    return () => document.fonts.removeEventListener('loadingdone', bump);
  }, []);

  const { width: cw, height: ch } = doc.settings;
  const scale = Math.max(0.02, Math.min((area.w - 48) / cw, (area.h - 48) / ch));
  scaleRef.current = scale;
  const mounted = new Set(key ? key.split(',') : []);
  const trackZ = new Map(doc.tracks.map((t, i) => [t.id, doc.tracks.length - i]));
  const layers = doc.items.filter((it) => mounted.has(it.id));

  const toProject = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = wrap.current!.querySelector('.stage-canvas')!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  const onDown = useCallback(
    (e: ReactPointerEvent, item: VisualItem): void => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const additive = isMod(e) || e.shiftKey;
      if (additive || !useEditor.getState().selection.includes(item.id)) selectItem(item.id, additive);
      if (additive) return;

      const state = useEditor.getState();
      const baseDoc = state.doc!;
      const ids = state.selection.filter((id) => {
        const it = baseDoc.items.find((x) => x.id === id);
        return it && isVisual(it);
      });
      const base = new Map(baseDoc.items.filter((it): it is VisualItem => ids.includes(it.id) && isVisual(it)).map((it) => [it.id, it]));
      const boxes = [...base.values()];
      const bounds = {
        x0: Math.min(...boxes.map((b) => b.x)),
        y0: Math.min(...boxes.map((b) => b.y)),
        x1: Math.max(...boxes.map((b) => b.x + b.w)),
        y1: Math.max(...boxes.map((b) => b.y + b.h)),
      };
      const sx = e.clientX;
      const sy = e.clientY;
      const k = scaleRef.current;
      let started = false;

      trackPointer(
        (ev) => {
          let dx = (ev.clientX - sx) / k;
          let dy = (ev.clientY - sy) / k;
          if (!started) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
            started = true;
            beginGesture();
          }
          // Snap the group's centre and edges to the centre and edges of the frame.
          const reach = 7 / k;
          const { width: W, height: H } = baseDoc.settings;
          const snap = (lo: number, hi: number, size: number, d: number): { d: number; centred: boolean } => {
            const options: [number, boolean][] = [
              [size / 2 - (lo + hi) / 2, true],
              [-lo, false],
              [size - hi, false],
            ];
            for (const [want, centred] of options) if (Math.abs(want - d) <= reach) return { d: want, centred };
            return { d, centred: false };
          };
          const fx = snap(bounds.x0, bounds.x1, W, dx);
          const fy = snap(bounds.y0, bounds.y1, H, dy);
          dx = fx.d;
          dy = fy.d;
          setGuides({ v: fx.centred, h: fy.centred });
          apply(() => updateItems(baseDoc, ids, (it) => (isVisual(it) ? { ...it, x: base.get(it.id)!.x + dx, y: base.get(it.id)!.y + dy } : it)));
        },
        (_ev, cancelled) => {
          setGuides({ v: false, h: false });
          if (!started) return;
          if (cancelled) cancelGesture();
          else endGesture();
        },
      );
    },
    [],
  );

  const startResize = (e: ReactPointerEvent, item: VisualItem, handle: Handle): void => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const baseDoc = useEditor.getState().doc!;
    const west = handle.includes('w');
    const north = handle.includes('n');
    const anchor = { x: west ? item.x + item.w : item.x, y: north ? item.y + item.h : item.y };
    let started = false;
    trackPointer(
      (ev) => {
        if (!started) {
          started = true;
          beginGesture();
        }
        const p = toProject(ev.clientX, ev.clientY);
        let next: VisualItem;
        if (handle === 'w' || handle === 'e') {
          // Side handles change the wrap width of text.
          const w = Math.max(40, handle === 'e' ? p.x - item.x : item.x + item.w - p.x);
          const x = handle === 'e' ? item.x : item.x + item.w - w;
          const t = item as TextItem;
          next = { ...t, x, w, h: textHeight(t.text, t.style, w) };
        } else {
          const s = Math.max(0.05, Math.abs(p.x - anchor.x) / item.w, Math.abs(p.y - anchor.y) / item.h);
          const w = item.w * s;
          let h = item.h * s;
          let scaled: VisualItem = { ...item, w, h };
          if (item.type === 'text') {
            const style = scaleTextStyle(item.style, s);
            h = textHeight(item.text, style, w);
            scaled = { ...item, style, w, h };
          }
          next = { ...scaled, x: west ? anchor.x - w : anchor.x, y: north ? anchor.y - h : anchor.y };
        }
        apply(() => updateItems(baseDoc, [item.id], () => next as Item));
      },
      (_ev, cancelled) => {
        if (!started) return;
        if (cancelled) cancelGesture();
        else endGesture();
      },
    );
  };

  const selectedVisible = doc.items.filter(
    (it): it is VisualItem => isVisual(it) && selection.includes(it.id) && (playhead < 0 || (playhead >= it.start - 1e-4 && playhead < it.start + it.duration)),
  );
  const single = selectedVisible.length === 1 && selection.length === 1 ? selectedVisible[0] : null;
  const handles: Handle[] = single ? (single.type === 'text' ? ['nw', 'ne', 'sw', 'se', 'w', 'e'] : ['nw', 'ne', 'sw', 'se']) : [];
  const empty = doc.items.length === 0;

  return (
    <div
      ref={wrap}
      className={`stage${dropping ? ' dropping' : ''}`}
      onPointerDown={() => clearSelection()}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void importPathsIntoProject(droppedPaths(e.dataTransfer), projectId);
      }}
    >
      <div className="stage-frame" style={{ width: cw * scale, height: ch * scale }}>
        <div className="stage-canvas" style={{ background: doc.settings.background }}>
          {layers.map((it) => {
            const z = trackZ.get(it.trackId) ?? 0;
            if (it.type === 'video') return <VideoLayer key={it.id} item={it} asset={assets[it.assetId]} scale={scale} z={z} onDown={onDown} />;
            if (it.type === 'image') return <ImageLayer key={it.id} item={it} asset={assets[it.assetId]} scale={scale} z={z} onDown={onDown} />;
            if (it.type === 'text') return <TextLayer key={it.id} item={it} asset={undefined} scale={scale} z={z} onDown={onDown} fontTick={fontTick} />;
            return null;
          })}
          {empty && (
            <div className="stage-empty">
              <Upload size={22} />
              <strong>Drop video, audio or images here</strong>
              <span>or add them from the panel on the left</span>
            </div>
          )}
        </div>
        <div className="stage-overlay">
          {guides.v && <div className="stage-guide v" />}
          {guides.h && <div className="stage-guide h" />}
          {selectedVisible.map((it) => (
            <div key={it.id} className="stage-selection" style={{ left: it.x * scale, top: it.y * scale, width: it.w * scale, height: it.h * scale }}>
              {single?.id === it.id &&
                handles.map((h) => <div key={h} className={`stage-handle ${h}`} onPointerDown={(e) => startResize(e, it, h)} />)}
            </div>
          ))}
        </div>
      </div>
      <div hidden>
        {layers.map((it) => (it.type === 'audio' ? <AudioLayer key={it.id} item={it} asset={assets[it.assetId]} /> : null))}
      </div>
    </div>
  );
}
