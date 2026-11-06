// media:// — how the renderer reads files from the library. The renderer never gets raw file
// access: it can only name a library object (an asset, a project thumbnail, an export, a brand font)
// and this handler maps that to a file inside the library folder.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import type { LibraryStore } from './library.ts';

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.ogv': 'video/ogg', '.flv': 'video/x-flv', '.ts': 'video/mp2t', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const SAFE_ID = /^[a-z]{3}_[0-9a-f]{16}$/;
const SAFE_FILE = /^[\w-]+\.[a-z0-9]+$/i;

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ]);
}

function resolve(lib: LibraryStore, url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  const [id, what] = parts;
  if (!id || !SAFE_ID.test(id)) return null;
  const p = lib.paths;
  switch (url.hostname) {
    case 'asset': {
      const a = lib.asset(id);
      if (!a) return null;
      switch (what) {
        case 'original': return p.assetOriginal(a);
        case 'preview': return p.assetPreview(a);
        case 'thumb': return p.assetThumb(a);
        case 'strip': return p.assetStrip(id);
        case 'wave': return p.assetWave(id);
        default: return null;
      }
    }
    case 'project':
      return what === 'thumb' ? p.projectThumb(id) : null;
    case 'template':
      return what === 'thumb' ? p.templateThumb(id) : null;
    case 'export':
      return what && SAFE_FILE.test(what) ? join(p.projectExports(id), what) : null;
    case 'brand':
      return what && SAFE_FILE.test(what) ? join(p.brandKitDir(id), what) : null;
    default:
      return null;
  }
}

async function serve(request: Request, file: string): Promise<Response> {
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return new Response('Not found', { status: 404 });
  const size = info.size;
  const headers: Record<string, string> = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  // Media elements seek by asking for byte ranges; without 206 responses video cannot be scrubbed.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range')?.trim() ?? '');
  if (range && (range[1] || range[2])) {
    let start: number;
    let end: number;
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

/** Must run after the app is ready. */
export function handleMediaProtocol(lib: LibraryStore): void {
  protocol.handle('media', async (request) => {
    try {
      const file = resolve(lib, new URL(request.url));
      return file ? await serve(request, file) : new Response('Not found', { status: 404 });
    } catch {
      return new Response('Error', { status: 500 });
    }
  });
}
