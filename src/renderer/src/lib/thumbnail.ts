// Project cards show a small picture of the project, drawn from the frame a moment into the video.

import { itemEnd, projectDuration } from '@shared/timeline';
import type { ProjectDoc, VisualItem } from '@shared/types';
import { getAssets } from '@/store/library';
import { api } from './api';
import { assetUrl, canvasBytes, loadImage } from './media';
import { drawTextItem } from './textRender';

const WIDTH = 480;

export async function renderThumbnail(doc: ProjectDoc): Promise<Uint8Array | null> {
  if (!doc.items.length) return null;
  const { width, height, background } = doc.settings;
  const scale = WIDTH / Math.max(width, height);
  const canvas = new OffscreenCanvas(Math.max(2, Math.round(width * scale)), Math.max(2, Math.round(height * scale)));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const t = Math.min(1, projectDuration(doc) / 3);
  const assets = getAssets();
  // Bottom layer first.
  for (let i = doc.tracks.length - 1; i >= 0; i--) {
    const visible = doc.items.filter(
      (it): it is VisualItem => it.trackId === doc.tracks[i].id && it.type !== 'audio' && t >= it.start && t < itemEnd(it),
    );
    for (const it of visible) {
      if (it.type === 'text') {
        drawTextItem(ctx, it, scale);
        continue;
      }
      const asset = assets[it.assetId];
      if (!asset?.hasThumb) continue;
      try {
        const img = await loadImage(assetUrl(asset, 'thumb'));
        ctx.globalAlpha = it.opacity;
        ctx.drawImage(img, it.x * scale, it.y * scale, it.w * scale, it.h * scale);
        ctx.globalAlpha = 1;
      } catch {
        // A missing poster just leaves that layer out of the thumbnail.
      }
    }
  }
  return canvasBytes(canvas, 'image/webp', 0.8);
}

export async function updateProjectThumb(doc: ProjectDoc): Promise<void> {
  const data = await renderThumbnail(doc);
  if (data) await api.library.setProjectThumb(doc.id, data);
}
