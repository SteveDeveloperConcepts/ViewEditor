// Work the renderer does for freshly imported media, because only Chromium can do it:
//  - images: read the true display size (EXIF rotation applied), make a poster, and when ffmpeg
//    cannot be trusted with the original (WebP, AVIF, rotated or oversized files) a PNG copy for export;
//  - video and audio: check that the editor can actually play the file, and ask for a proxy if not.

import type { Asset } from '@shared/types';
import { api } from './api';
import { assetUrl, canvasBytes, loadImage } from './media';
import { useLibrary } from '@/store/library';

const handled = new Set<string>();
let running = false;

const MAX_RASTER = 8192;
const POSTER = 480;

async function intakeImage(asset: Asset): Promise<void> {
  const img = await loadImage(assetUrl(asset, 'original'));
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error('empty image');

  const s = Math.min(1, POSTER / Math.max(width, height));
  const poster = new OffscreenCanvas(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)));
  poster.getContext('2d')!.drawImage(img, 0, 0, poster.width, poster.height);
  const thumb = await canvasBytes(poster, 'image/webp', 0.82);

  const rotated = width !== asset.width || height !== asset.height;
  const oversized = Math.max(width, height) > MAX_RASTER;
  let raster: Uint8Array | null = null;
  let outW = width;
  let outH = height;
  if (asset.ext === 'webp' || asset.ext === 'avif' || rotated || oversized) {
    const r = Math.min(1, MAX_RASTER / Math.max(width, height));
    outW = Math.max(1, Math.round(width * r));
    outH = Math.max(1, Math.round(height * r));
    const full = new OffscreenCanvas(outW, outH);
    full.getContext('2d')!.drawImage(img, 0, 0, outW, outH);
    raster = await canvasBytes(full, 'image/png');
  }
  await api.assets.putImageDerivatives(asset.id, { width: outW, height: outH, thumb, raster });
}

function canPlay(asset: Asset): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement(asset.kind === 'video' ? 'video' : 'audio');
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 12000);
    el.preload = 'auto';
    el.muted = true;
    el.onerror = () => finish(false);
    el.onloadeddata = () => finish(asset.kind === 'audio' || (el as HTMLVideoElement).videoWidth > 0);
    el.src = assetUrl(asset, 'original');
  });
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const assets = useLibrary.getState().lib?.assets ?? [];
      const next = assets.find((a) => !handled.has(a.id) && ((a.kind === 'image' && !a.hasThumb) || (a.kind !== 'image' && !a.previewChecked && a.proxy === 'none')));
      if (!next) break;
      handled.add(next.id);
      try {
        if (next.kind === 'image') await intakeImage(next);
        else if (await canPlay(next)) await api.assets.markPreviewChecked(next.id);
        else await api.assets.requestProxy(next.id);
      } catch {
        // Leave the asset as it is; it shows a generic icon and can still be used.
      }
    }
  } finally {
    running = false;
  }
}

/** Starts watching the library for media that still needs this treatment. */
export function startIntake(): () => void {
  void run();
  return useLibrary.subscribe((state, prev) => {
    if (state.lib?.assets !== prev.lib?.assets) void run();
  });
}
