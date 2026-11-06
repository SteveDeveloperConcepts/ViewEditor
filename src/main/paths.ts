import { join } from 'node:path';
import type { Asset, ID } from '../shared/types.ts';

/** Where everything lives on disk. One folder per library, so it can be moved or backed up as a unit. */
export class Paths {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  get libraryFile(): string {
    return join(this.root, 'library.json');
  }
  get projectsDir(): string {
    return join(this.root, 'projects');
  }
  get templatesDir(): string {
    return join(this.root, 'templates');
  }
  get assetsDir(): string {
    return join(this.root, 'assets');
  }
  get exportsDir(): string {
    return join(this.root, 'exports');
  }
  get brandDir(): string {
    return join(this.root, 'brand');
  }
  get tmpDir(): string {
    return join(this.root, 'tmp');
  }

  projectFile(id: ID): string {
    return join(this.projectsDir, `${id}.json`);
  }
  projectThumb(id: ID): string {
    return join(this.projectsDir, `${id}.thumb.webp`);
  }
  templateFile(id: ID): string {
    return join(this.templatesDir, `${id}.json`);
  }
  templateThumb(id: ID): string {
    return join(this.templatesDir, `${id}.thumb.webp`);
  }
  projectExports(id: ID): string {
    return join(this.exportsDir, id);
  }
  brandKitDir(id: ID): string {
    return join(this.brandDir, id);
  }

  assetDir(id: ID): string {
    return join(this.assetsDir, id);
  }
  assetOriginal(a: Pick<Asset, 'id' | 'ext'>): string {
    return join(this.assetDir(a.id), `original.${a.ext}`);
  }
  assetProxy(a: Pick<Asset, 'id' | 'proxyExt'>): string {
    return join(this.assetDir(a.id), `proxy.${a.proxyExt ?? 'mp4'}`);
  }
  assetRaster(id: ID): string {
    return join(this.assetDir(id), 'raster.png');
  }
  assetStrip(id: ID): string {
    return join(this.assetDir(id), 'strip.jpg');
  }
  assetWave(id: ID): string {
    return join(this.assetDir(id), 'wave.png');
  }
  /** Video posters are JPEG (made by ffmpeg); image posters are WebP (made by the renderer, keeps transparency). */
  assetThumb(a: Pick<Asset, 'id' | 'kind'>): string {
    return join(this.assetDir(a.id), a.kind === 'image' ? 'thumb.webp' : 'thumb.jpg');
  }
  /** File the exporter reads for this asset. */
  assetRenderSource(a: Asset): string {
    return a.raster === 'ready' ? this.assetRaster(a.id) : this.assetOriginal(a);
  }
  /** File the editor preview plays for this asset. */
  assetPreview(a: Asset): string {
    return a.proxy === 'ready' ? this.assetProxy(a) : this.assetOriginal(a);
  }
}
