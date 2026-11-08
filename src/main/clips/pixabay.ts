// Pixabay: free stock video. https://pixabay.com/api/docs/

import { makeClip, shapeOf, type FreeClip } from '../../shared/clips.ts';
import { call } from '../ai/http.ts';
import type { ClipPage, ClipQuery, ClipService } from './service.ts';

const API = 'https://pixabay.com/api/videos/';
const NAME = 'Pixabay';

/** The service reads at most this much of a search. */
const MAX_QUERY = 100;

interface PixabayFile {
  url: string;
  width: number;
  height: number;
  thumbnail?: string;
}

export interface PixabayHit {
  id: number;
  pageURL: string;
  tags?: string;
  duration: number;
  /** Any of these can be missing. A size that does not exist comes back with an empty address. */
  videos?: Partial<Record<'large' | 'medium' | 'small' | 'tiny', PixabayFile>>;
  user?: string;
  user_id?: number;
}

export interface PixabayAnswer {
  totalHits?: number;
  hits?: PixabayHit[];
}

function titleOf(hit: PixabayHit): string {
  const tags = hit.tags?.trim();
  return tags ? tags[0].toUpperCase() + tags.slice(1) : `Pixabay video ${hit.id}`;
}

export function readPixabay(answer: PixabayAnswer, q: ClipQuery): ClipPage {
  const clips = (answer.hits ?? [])
    .map((hit) => {
      const { large, medium, small, tiny } = hit.videos ?? {};
      const files = [large, medium, small, tiny].filter((f): f is PixabayFile => !!f);
      return makeClip({
        id: hit.id,
        service: 'pixabay',
        title: titleOf(hit),
        creator: hit.user || 'Unknown',
        creatorUrl: hit.user && hit.user_id ? `https://pixabay.com/users/${encodeURIComponent(hit.user)}-${hit.user_id}/` : null,
        pageUrl: hit.pageURL,
        duration: hit.duration,
        picture: [...files].reverse().find((f) => f.thumbnail)?.thumbnail ?? '',
        files: files.map(({ url, width, height }) => ({ url, width, height })),
      });
    })
    // The service has no way to ask for a shape.
    .filter((c): c is FreeClip => !!c && (q.shape === 'any' || shapeOf(c) === q.shape));
  return { clips, hasMore: q.page * q.perPage < (answer.totalHits ?? 0) };
}

export const pixabay: ClipService = {
  id: 'pixabay',
  name: NAME,
  tagline: 'Free videos shared by its community of creators.',
  homeUrl: 'https://pixabay.com',
  keyUrl: 'https://pixabay.com/api/docs/#api_search_videos',
  licenseUrl: 'https://pixabay.com/service/license-summary/',
  terms: 'Free to use, including in commercial work, and no credit is needed. You cannot sell or share a clip on its own, or use one showing a brand or logo commercially.',

  async verify(key) {
    await call(`${API}?${new URLSearchParams({ key, per_page: '3' })}`, NAME);
  },

  async search(key, q) {
    const params = new URLSearchParams({ key, page: String(q.page), per_page: String(q.perPage), safesearch: 'true' });
    if (q.query) params.set('q', q.query.slice(0, MAX_QUERY));
    return readPixabay(await call<PixabayAnswer>(`${API}?${params}`, NAME), q);
  },
};
