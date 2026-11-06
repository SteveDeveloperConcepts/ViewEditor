// Addresses of library files, as understood by the media:// protocol in the main process.
// Each address carries a small version tag so a file that was rewritten is fetched again.

import type { Asset, ProjectMeta, TemplateMeta } from '@shared/types';

export function assetUrl(asset: Asset, what: 'original' | 'preview' | 'thumb' | 'strip' | 'wave'): string {
  const version =
    what === 'preview' ? `${asset.proxy}-${asset.proxyExt ?? 'o'}` : what === 'strip' ? String(asset.strip?.count ?? 0) : `${asset.width}x${asset.height}`;
  return `media://asset/${asset.id}/${what}?v=${version}`;
}

export function projectThumbUrl(meta: Pick<ProjectMeta, 'id' | 'thumbVersion'>): string | null {
  return meta.thumbVersion > 0 ? `media://project/${meta.id}/thumb?v=${meta.thumbVersion}` : null;
}

export function templateThumbUrl(meta: Pick<TemplateMeta, 'id' | 'thumbVersion'>): string | null {
  return meta.thumbVersion > 0 ? `media://template/${meta.id}/thumb?v=${meta.thumbVersion}` : null;
}

export function exportUrl(meta: ProjectMeta): string | null {
  return meta.lastExport ? `media://export/${meta.id}/${meta.lastExport.file}` : null;
}

export function brandFontUrl(kitId: string, file: string): string {
  return `media://brand/${kitId}/${file}`;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be decoded.'));
    img.src = url;
  });
}

export async function canvasBytes(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob =
    canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type, quality })
      : await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}
