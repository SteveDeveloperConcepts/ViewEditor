// A local stand-in for fal.ai, Runway and Replicate. It speaks each service's real protocol and serves
// their real published schemas (saved in tests/fixtures/ai), so the app can be tested end to end without
// spending anything. It records every request, so tests can check exactly what the app sent.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');

export const KEYS = { fal: 'fal-good-key', runway: 'runway-good-key', replicate: 'replicate-good-key' };

export interface FakeCall {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
  raw: Buffer;
}

interface Task {
  polls: number;
  provider: string;
  input: unknown;
  cancelled: boolean;
  image: boolean;
}

const REPLICATE_MODELS = [
  {
    owner: 'kwaivgi', name: 'kling-v4.0', description: 'Generate and edit video',
    latest_version: {
      id: 'ver-kling',
      openapi_schema: {
        components: {
          schemas: {
            aspect_ratio: { title: 'aspect_ratio', enum: ['16:9', '9:16', '1:1', '21:9'], type: 'string' },
            resolution: { title: 'resolution', enum: ['720p', '1080p'], type: 'string' },
            Input: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt: { type: 'string', title: 'Prompt' },
                start_image: { type: 'string', format: 'uri', title: 'Start Image' },
                base_video: { type: 'string', format: 'uri', title: 'Base Video' },
                duration: { type: 'integer', default: 5, minimum: 3, maximum: 30, title: 'Duration' },
                aspect_ratio: { allOf: [{ $ref: '#/components/schemas/aspect_ratio' }], default: '16:9' },
                resolution: { allOf: [{ $ref: '#/components/schemas/resolution' }], default: '720p' },
              },
            },
          },
        },
      },
    },
  },
  {
    owner: 'veed', name: 'fabric-1.0', description: 'Turn an image into a talking video',
    latest_version: {
      id: 'ver-fabric',
      openapi_schema: {
        components: {
          schemas: {
            resolution: { title: 'resolution', enum: ['720p', '480p'], type: 'string' },
            Input: {
              type: 'object',
              required: ['image', 'audio'],
              properties: {
                image: { type: 'string', format: 'uri' },
                audio: { type: 'string', format: 'uri' },
                resolution: { allOf: [{ $ref: '#/components/schemas/resolution' }], default: '720p' },
              },
            },
          },
        },
      },
    },
  },
];

const REPLICATE_COLLECTIONS: Record<string, string[]> = {
  'text-to-video': ['kwaivgi/kling-v4.0'],
  'image-to-video': ['kwaivgi/kling-v4.0', 'veed/fabric-1.0'],
  'video-editing': ['kwaivgi/kling-v4.0'],
  lipsync: [],
  'text-to-image': [],
};

export class FakeProviders {
  readonly calls: FakeCall[] = [];
  readonly uploads: { name: string; type: string; bytes: Buffer }[] = [];
  /** How many status checks a job takes before it finishes. */
  pollsToFinish = 2;
  /** The next status checks answer with a server error, to test that a job rides out a bad connection. */
  flakyPolls = 0;
  /** The next jobs fail, with this message. */
  failJobsWith: string | null = null;
  /** The next submission is refused with this status. */
  refuseSubmit: number | null = null;

  private server!: Server;
  private readonly tasks = new Map<string, Task>();
  private nextId = 1;
  private readonly video = readFileSync(join(fixtures, 'media', 'clip-b.mp4'));
  private readonly picture = readFileSync(join(fixtures, 'media', 'logo.png'));
  private readonly falModels = JSON.parse(readFileSync(join(fixtures, 'ai', 'fal-models.json'), 'utf8')) as { endpoint_id: string; metadata?: { category?: string } }[];
  private readonly runwaySpec = readFileSync(join(fixtures, 'ai', 'runway-openapi.json'));

  get base(): string {
    const a = this.server.address();
    return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }

  /** Value for the VIEWEDITOR_AI_HOSTS environment variable. */
  get hosts(): string {
    return JSON.stringify({
      'https://queue.fal.run': `${this.base}/fal-queue`,
      'https://api.fal.ai/v1': `${this.base}/fal-api/v1`,
      'https://rest.fal.ai': `${this.base}/fal-rest`,
      'https://api.dev.runwayml.com': `${this.base}/runway`,
      'https://docs.dev.runwayml.com': `${this.base}/runway-docs`,
      'https://api.replicate.com/v1': `${this.base}/replicate/v1`,
    });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return this;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  callsTo(fragment: string, method?: string): FakeCall[] {
    return this.calls.filter((c) => c.path.includes(fragment) && (!method || c.method === method));
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private newTask(provider: string, input: unknown, image = false): string {
    const id = `task-${this.nextId++}`;
    this.tasks.set(id, { polls: 0, provider, input, cancelled: false, image });
    return id;
  }

  /** Moves a job one step along. */
  private step(id: string): 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown' {
    const t = this.tasks.get(id);
    if (!t) return 'unknown';
    if (t.cancelled) return 'cancelled';
    t.polls++;
    if (t.polls === 1) return 'waiting';
    if (t.polls < this.pollsToFinish) return 'running';
    return this.failJobsWith ? 'failed' : 'done';
  }

  private fileUrl(image: boolean): string {
    return `${this.base}/files/${image ? 'result.png' : 'result.mp4'}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', this.base);
    let body: unknown = null;
    if ((req.headers['content-type'] ?? '').includes('json') && raw.length) body = JSON.parse(raw.toString());
    this.calls.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body, raw });

    const p = url.pathname;
    if (p.startsWith('/files/')) {
      const image = p.endsWith('.png');
      res.writeHead(200, { 'Content-Type': image ? 'image/png' : 'video/mp4' });
      res.end(image ? this.picture : this.video);
    } else if (p.startsWith('/fal-')) this.fal(req, res, url, body, raw);
    else if (p.startsWith('/runway-docs/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(this.runwaySpec);
    } else if (p === '/runway-upload') {
      this.uploads.push({ name: 'multipart', type: String(req.headers['content-type']), bytes: raw });
      res.writeHead(204).end();
    } else if (p.startsWith('/runway/')) this.runway(req, res, p, body);
    else if (p.startsWith('/replicate/')) this.replicate(req, res, p, body, raw);
    else res.writeHead(404).end();
  }

  // ---- fal.ai

  private fal(req: IncomingMessage, res: ServerResponse, url: URL, body: unknown, raw: Buffer): void {
    const p = url.pathname;
    const keyOk = req.headers.authorization === `Key ${KEYS.fal}`;
    if (p === '/fal-api/v1/models') {
      // The real catalogue allows ten per page once schemas are included, and needs no key.
      const limit = Number(url.searchParams.get('limit') ?? 10);
      if (url.searchParams.getAll('expand').length && limit > 10) return this.json(res, 400, { error: { type: 'validation_error', message: `Requested limit ${limit} exceeds maximum of 10 for this query` } });
      const ids = url.searchParams.getAll('endpoint_id');
      const category = url.searchParams.get('category');
      const models = this.falModels.filter((m) => (ids.length ? ids.includes(m.endpoint_id) : m.metadata?.category === category));
      return this.json(res, 200, { models, next_cursor: null, has_more: false });
    }
    if (!keyOk && !p.startsWith('/fal-upload')) return this.json(res, 401, { detail: 'Invalid key' });
    if (p === '/fal-api/v1/models/pricing') return this.json(res, 200, { prices: [{ endpoint_id: 'x', unit_price: 0.15, unit: 'second', currency: 'USD' }], next_cursor: null, has_more: false });
    if (p === '/fal-rest/storage/upload/initiate') {
      const b = body as { file_name: string };
      return this.json(res, 200, { upload_url: `${this.base}/fal-upload/${b.file_name}`, file_url: `https://v3.fal.media/files/test/${b.file_name}` });
    }
    if (p.startsWith('/fal-upload/')) {
      this.uploads.push({ name: p.split('/').pop()!, type: String(req.headers['content-type']), bytes: raw });
      res.writeHead(200).end();
      return;
    }
    const parts = /^\/fal-queue\/(.+?)\/requests\/([^/]+)(\/status|\/cancel)?$/.exec(p);
    if (parts) {
      const [, , id, tail] = parts;
      if (tail === '/cancel') {
        const t = this.tasks.get(id);
        if (t) t.cancelled = true;
        return this.json(res, 202, { status: 'CANCELLATION_REQUESTED' });
      }
      if (tail === '/status') {
        if (this.flakyPolls > 0) {
          this.flakyPolls--;
          return this.json(res, 503, { detail: 'Temporarily unavailable' });
        }
        const s = this.step(id);
        if (s === 'waiting') return this.json(res, 202, { status: 'IN_QUEUE', queue_position: 3 });
        if (s === 'running') return this.json(res, 202, { status: 'IN_PROGRESS' });
        if (s === 'failed') return this.json(res, 200, { status: 'COMPLETED', error: this.failJobsWith });
        return this.json(res, 200, { status: 'COMPLETED' });
      }
      const image = this.tasks.get(id)?.image ?? false;
      return this.json(res, 200, image ? { images: [{ url: this.fileUrl(true) }] } : { video: { url: this.fileUrl(false), content_type: 'video/mp4' } });
    }
    if (p.startsWith('/fal-queue/') && req.method === 'POST') {
      if (this.refuseSubmit) {
        const status = this.refuseSubmit;
        this.refuseSubmit = null;
        return this.json(res, status, { detail: [{ loc: ['body', 'prompt'], msg: 'Prompt was refused' }] });
      }
      const model = p.slice('/fal-queue/'.length);
      const id = this.newTask('fal', body, /flux\/schnell/.test(model));
      const owner = model.split('/').slice(0, 2).join('/');
      const root = `https://queue.fal.run/${owner}/requests/${id}`;
      return this.json(res, 200, { request_id: id, status_url: `${root}/status`, response_url: root, cancel_url: `${root}/cancel`, queue_position: 3 });
    }
    res.writeHead(404).end();
  }

  // ---- Runway

  private runway(req: IncomingMessage, res: ServerResponse, p: string, body: unknown): void {
    if (req.headers.authorization !== `Bearer ${KEYS.runway}`) return this.json(res, 401, { error: 'Invalid API key' });
    if (req.headers['x-runway-version'] !== '2024-11-06') return this.json(res, 400, { error: 'Missing X-Runway-Version' });
    if (p === '/runway/v1/organization') return this.json(res, 200, { creditBalance: 12500 });
    if (p === '/runway/v1/uploads') {
      const b = body as { filename: string; type: string };
      return this.json(res, 200, { uploadUrl: `${this.base}/runway-upload`, fields: { key: 'abc', policy: 'xyz' }, runwayUri: `runway://upload/${b.filename}` });
    }
    const task = /^\/runway\/v1\/tasks\/([^/]+)$/.exec(p);
    if (task) {
      const id = task[1];
      if (req.method === 'DELETE') {
        const t = this.tasks.get(id);
        if (t) t.cancelled = true;
        res.writeHead(204).end();
        return;
      }
      const s = this.step(id);
      if (s === 'waiting') return this.json(res, 200, { id, status: 'THROTTLED' });
      if (s === 'running') return this.json(res, 200, { id, status: 'RUNNING', progress: 0.4 });
      if (s === 'cancelled') return this.json(res, 200, { id, status: 'CANCELLED' });
      if (s === 'failed') return this.json(res, 200, { id, status: 'FAILED', failure: this.failJobsWith, failureCode: 'SAFETY.INPUT.TEXT' });
      return this.json(res, 200, { id, status: 'SUCCEEDED', output: [this.fileUrl(this.tasks.get(id)?.image ?? false)] });
    }
    if (/^\/runway\/v1\/(text_to_video|image_to_video|video_to_video|text_to_image)$/.test(p)) {
      return this.json(res, 200, { id: this.newTask('runway', body, p.endsWith('text_to_image')) });
    }
    res.writeHead(404).end();
  }

  // ---- Replicate

  private replicate(req: IncomingMessage, res: ServerResponse, p: string, body: unknown, raw: Buffer): void {
    if (req.headers.authorization !== `Bearer ${KEYS.replicate}`) return this.json(res, 401, { detail: 'Invalid token' });
    const path = p.replace('/replicate/v1', '');
    if (path === '/account') return this.json(res, 200, { username: 'test-user', type: 'user' });
    if (path === '/files') {
      this.uploads.push({ name: 'multipart', type: String(req.headers['content-type']), bytes: raw });
      return this.json(res, 201, { id: 'file-1', urls: { get: 'https://api.replicate.com/v1/files/file-1/download' } });
    }
    const collection = /^\/collections\/(.+)$/.exec(path);
    if (collection) {
      const names = REPLICATE_COLLECTIONS[collection[1]];
      if (!names) return this.json(res, 404, { detail: 'Not found' });
      // Listings leave out the schema, as the real one may: the app has to ask for each model.
      return this.json(res, 200, { slug: collection[1], models: names.map((n) => ({ owner: n.split('/')[0], name: n.split('/')[1] })) });
    }
    const model = /^\/models\/([^/]+)\/([^/]+)$/.exec(path);
    if (model) return this.json(res, 200, REPLICATE_MODELS.find((m) => m.owner === model[1] && m.name === model[2]));
    if (/^\/models\/[^/]+\/[^/]+\/predictions$/.test(path)) {
      const id = this.newTask('replicate', (body as { input: unknown }).input);
      return this.json(res, 201, { id, status: 'starting', urls: { get: `https://api.replicate.com/v1/predictions/${id}`, cancel: `https://api.replicate.com/v1/predictions/${id}/cancel` } });
    }
    const prediction = /^\/predictions\/([^/]+)(\/cancel)?$/.exec(path);
    if (prediction) {
      const id = prediction[1];
      if (prediction[2]) {
        const t = this.tasks.get(id);
        if (t) t.cancelled = true;
        return this.json(res, 200, { id, status: 'canceled' });
      }
      const s = this.step(id);
      if (s === 'waiting') return this.json(res, 200, { id, status: 'starting' });
      if (s === 'running') return this.json(res, 200, { id, status: 'processing' });
      if (s === 'cancelled') return this.json(res, 200, { id, status: 'canceled' });
      if (s === 'failed') return this.json(res, 200, { id, status: 'failed', error: this.failJobsWith });
      return this.json(res, 200, { id, status: 'succeeded', output: this.fileUrl(false) });
    }
    res.writeHead(404).end();
  }
}
