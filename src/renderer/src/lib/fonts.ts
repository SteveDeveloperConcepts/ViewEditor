// Brand kit fonts are files in the library. Registering them with the page makes them usable
// in the canvas text renderer, which draws both the preview and the exported video.

import type { BrandKit } from '@shared/types';
import { brandFontUrl } from './media';

const loaded = new Map<string, Promise<void>>();

export function loadBrandFonts(kits: BrandKit[]): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const kit of kits) {
    for (const font of kit.fonts) {
      if (!loaded.has(font.id)) {
        const face = new FontFace(font.family, `url("${brandFontUrl(kit.id, font.file)}")`);
        loaded.set(
          font.id,
          face.load().then(
            (f) => void document.fonts.add(f),
            () => undefined,
          ),
        );
      }
      jobs.push(loaded.get(font.id)!);
    }
  }
  return Promise.all(jobs).then(() => undefined);
}

/** Resolves once every font that has started loading is ready to draw with. */
export async function fontsReady(): Promise<void> {
  await Promise.all(loaded.values());
  await document.fonts.ready;
}
