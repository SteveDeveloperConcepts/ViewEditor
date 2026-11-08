// Pexels: free stock video. https://www.pexels.com/api/documentation/

import { makeClip, shapeOf, type ClipFile, type ClipShape, type FreeClip } from '../../shared/clips.ts';
import { call } from '../ai/http.ts';
import type { ClipPage, ClipQuery, ClipService } from './service.ts';

const API = 'https://api.pexels.com/v1/videos';
const NAME = 'Pexels';

/** Only a search can ask for a shape. The popular list has to be sorted through afterwards. */
const ORIENTATION: Record<Exclude<ClipShape, 'any'>, string> = { wide: 'landscape', tall: 'portrait', square: 'square' };

interface PexelsFile {
  quality: string;
  file_type: string;
  width: number | null;
  height: number | null;
  link: string;
}

export interface PexelsVideo {
  id: number;
  url: string;
  image: string;
  duration: number;
  user?: { name?: string; url?: string };
  video_files?: PexelsFile[];
}

export interface PexelsAnswer {
  page?: number;
  per_page?: number;
  total_results?: number;
  next_page?: string;
  videos?: PexelsVideo[];
}

/** A page address such as /video/video-of-forest-1448735/ is the only description a video has. */
function titleOf(video: PexelsVideo): string {
  const words = /\/video\/(.+?)-\d+\/?$/.exec(video.url ?? '')?.[1]?.replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : `Pexels video ${video.id}`;
}

/** Streams are listed with the files, but they are not something a person can download. */
function playable(files: PexelsFile[] = []): ClipFile[] {
  return files
    .filter((f) => f.quality !== 'hls' && f.file_type === 'video/mp4' && !/\.m3u8(\?|$)/i.test(f.link ?? ''))
    .map((f) => ({ width: f.width ?? 0, height: f.height ?? 0, url: f.link }));
}

export function readPexels(answer: PexelsAnswer, q: ClipQuery, sorted: boolean): ClipPage {
  const clips = (answer.videos ?? [])
    .map((v) =>
      makeClip({
        id: v.id,
        service: 'pexels',
        title: titleOf(v),
        creator: v.user?.name || 'Unknown',
        creatorUrl: v.user?.url ?? null,
        pageUrl: v.url,
        duration: v.duration,
        picture: v.image,
        files: playable(v.video_files),
      }),
    )
    .filter((c): c is FreeClip => !!c && (sorted || q.shape === 'any' || shapeOf(c) === q.shape));
  const seen = (answer.page ?? q.page) * (answer.per_page ?? q.perPage);
  return { clips, hasMore: !!answer.next_page || seen < (answer.total_results ?? 0) };
}

export const pexels: ClipService = {
  id: 'pexels',
  name: NAME,
  tagline: 'Free videos from photographers and filmmakers around the world.',
  homeUrl: 'https://www.pexels.com',
  keyUrl: 'https://www.pexels.com/api/',
  licenseUrl: 'https://www.pexels.com/license/',
  terms: 'Free to use, including in commercial work, and no credit is needed. You cannot sell a clip unchanged, show people in it in a bad light, or suggest they endorse something.',

  async verify(key) {
    await call(`${API}/popular?per_page=1`, NAME, { headers: { Authorization: key } });
  },

  async search(key, q) {
    const shaped = q.shape !== 'any';
    const params = new URLSearchParams({ page: String(q.page), per_page: String(q.perPage) });
    if (q.query) {
      params.set('query', q.query);
      if (shaped) params.set('orientation', ORIENTATION[q.shape as keyof typeof ORIENTATION]);
    }
    const path = q.query ? 'search' : 'popular';
    const answer = await call<PexelsAnswer>(`${API}/${path}?${params}`, NAME, { headers: { Authorization: key } });
    return readPexels(answer, q, !!q.query);
  },
};
