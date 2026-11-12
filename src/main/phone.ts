// "Upload from phone": while the dialog is open, a small web server on the local network
// serves one page that lets a phone send files straight into the library. The address carries
// a random token, and the server is shut down as soon as the dialog closes.

import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import QRCode from 'qrcode';
import type { PhoneSession } from '../shared/api.ts';
import { ALL_MEDIA_EXTS, extOf } from '../shared/constants.ts';
import { newId } from '../shared/time.ts';
import type { ImportResult } from '../shared/types.ts';
import type { AssetManager, ImportOptions } from './assets.ts';
import type { LibraryStore } from './library.ts';

function lanAddress(): string | null {
  const candidates: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    }
  }
  const isPrivate = (ip: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Send to Homecut</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 24px 20px 40px; max-width: 520px; margin-inline: auto; }
  h1 { font-size: 22px; margin: 8px 0 4px; }
  p { margin: 0 0 20px; opacity: .75; }
  label.pick { display: block; padding: 28px 16px; border: 2px dashed #8a8fa3; border-radius: 16px; text-align: center; font-weight: 600; }
  input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; }
  ul { list-style: none; padding: 0; margin: 20px 0 0; }
  li { padding: 12px 0; border-bottom: 1px solid #8a8fa340; }
  .name { display: flex; justify-content: space-between; gap: 12px; }
  .name span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 6px; border-radius: 3px; background: #8a8fa340; margin-top: 8px; overflow: hidden; }
  .bar i { display: block; height: 100%; width: 0; background: #4f7cff; transition: width .15s; }
  .ok { color: #1a9f5c; } .bad { color: #d6455d; }
</style>
</head>
<body>
<h1>Send files to Homecut</h1>
<p>Choose videos, audio or images. They appear on your computer as soon as they finish.</p>
<label class="pick">Choose files<input id="pick" type="file" multiple accept="video/*,audio/*,image/*"></label>
<ul id="list"></ul>
<script>
  const list = document.getElementById('list');
  const queue = [];
  let busy = false;
  document.getElementById('pick').addEventListener('change', (e) => {
    for (const file of e.target.files) {
      const li = document.createElement('li');
      const row = document.createElement('div'); row.className = 'name';
      const name = document.createElement('span'); name.textContent = file.name;
      const state = document.createElement('span'); state.textContent = 'Waiting';
      row.append(name, state);
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i'); bar.append(fill);
      li.append(row, bar); list.append(li);
      queue.push({ file, state, fill });
    }
    e.target.value = '';
    next();
  });
  function next() {
    if (busy || !queue.length) return;
    busy = true;
    const { file, state, fill } = queue.shift();
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location.pathname.replace(/\\/$/, '') + '/upload?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) { fill.style.width = (100 * ev.loaded / ev.total) + '%'; state.textContent = Math.round(100 * ev.loaded / ev.total) + '%'; } };
    const done = (ok, text) => { state.textContent = text; state.className = ok ? 'ok' : 'bad'; if (ok) fill.style.width = '100%'; busy = false; next(); };
    xhr.onload = () => { let r = {}; try { r = JSON.parse(xhr.responseText); } catch {} done(xhr.status === 200 && r.ok, xhr.status === 200 && r.ok ? 'Sent' : (r.reason || 'Failed')); };
    xhr.onerror = () => done(false, 'Connection lost');
    xhr.send(file);
  }
</script>
</body>
</html>`;

export class PhoneUpload {
  private readonly lib: LibraryStore;
  private readonly assets: AssetManager;
  private readonly onReceived: (r: ImportResult) => void;
  private server: Server | null = null;
  private token = '';
  private dir = '';
  private target: ImportOptions = { scope: 'workspace' };

  constructor(lib: LibraryStore, assets: AssetManager, onReceived: (r: ImportResult) => void) {
    this.lib = lib;
    this.assets = assets;
    this.onReceived = onReceived;
  }

  async start(target: ImportOptions): Promise<PhoneSession> {
    await this.stop();
    const host = lanAddress();
    if (!host) throw new Error('This computer is not connected to a network, so a phone cannot reach it.');
    this.target = target;
    this.token = randomBytes(16).toString('hex');
    this.dir = join(this.lib.paths.tmpDir, newId('phn'));
    await mkdir(this.dir, { recursive: true });

    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = `http://${host}:${port}/${this.token}`;

    const modules = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules;
    let path = '';
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(x, y)) path += `M${x} ${y}h1v1h-1z`;
      }
    }
    return { url, qr: { size: modules.size, path } };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.dir) await rm(this.dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
    this.dir = '';
    this.token = '';
  }

  private json(res: ServerResponse, status: number, body: object): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      // Anything without the token gets the same blank answer, so the server gives nothing away.
      if (!this.token || parts[0] !== this.token) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === 'GET' && parts.length === 1) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'PUT' && parts[1] === 'upload') {
        const raw = url.searchParams.get('name') ?? '';
        const name = raw.split(/[\\/]/).pop()!.replace(/[\x00-\x1f<>:"|?*]/g, '_').slice(0, 180);
        const ext = extOf(name);
        if (!name || !ALL_MEDIA_EXTS.includes(ext)) {
          req.resume();
          this.json(res, 200, { ok: false, reason: 'File type not supported' });
          return;
        }
        const tmp = join(this.dir, `${newId('up')}.${ext}`);
        await pipeline(req, createWriteStream(tmp));
        const result = await this.assets.importFiles([tmp], { ...this.target, move: true, source: 'phone', names: [name] });
        this.onReceived(result);
        if (result.assets.length) this.json(res, 200, { ok: true });
        else this.json(res, 200, { ok: false, reason: result.rejected[0]?.reason ?? 'Could not be imported' });
        return;
      }
      res.writeHead(404).end();
    } catch {
      if (!res.headersSent) this.json(res, 500, { ok: false, reason: 'Upload failed' });
      else res.end();
    }
  }
}
