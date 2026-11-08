import type { ClipServiceId, ClipShape, FreeClip } from '../../shared/clips.ts';

export interface ClipQuery {
  /** Empty for what is popular. */
  query: string;
  shape: ClipShape;
  page: number;
  perPage: number;
}

export interface ClipPage {
  clips: FreeClip[];
  hasMore: boolean;
}

/** Everything the app needs from a stock video library. Adding a library means writing one of these. */
export interface ClipService {
  id: ClipServiceId;
  name: string;
  tagline: string;
  homeUrl: string;
  keyUrl: string;
  licenseUrl: string;
  /** What the clips may be used for, in plain words. */
  terms: string;
  /** Tries a key. Throws when the service refuses it. */
  verify(key: string): Promise<void>;
  search(key: string, query: ClipQuery): Promise<ClipPage>;
}
