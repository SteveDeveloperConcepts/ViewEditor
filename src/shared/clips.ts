// Free clips from stock video libraries: what a search finds, and which file of a clip to fetch.

export type ClipServiceId = 'pexels' | 'pixabay';

export type ClipShape = 'any' | 'wide' | 'tall' | 'square';

export interface ClipServiceStatus {
  id: ClipServiceId;
  name: string;
  tagline: string;
  homeUrl: string;
  keyUrl: string;
  licenseUrl: string;
  /** What the clips may be used for, in plain words. */
  terms: string;
  connected: boolean;
}

export interface Size {
  width: number;
  height: number;
}

export interface ClipFile extends Size {
  url: string;
}

export interface FreeClip extends Size {
  /** Which clip this is, across services: 'pexels:1448735'. */
  key: string;
  service: ClipServiceId;
  title: string;
  creator: string;
  creatorUrl: string | null;
  /** The clip's own page at the service. */
  pageUrl: string;
  duration: number;
  /** A still from the clip. */
  picture: string;
  /** A small copy to watch before deciding. */
  preview: string;
  files: ClipFile[];
}

export interface ClipSearch {
  /** Empty for what is popular. */
  query: string;
  shape: ClipShape;
  page: number;
}

export interface ClipResults {
  clips: FreeClip[];
  hasMore: boolean;
  /** What went wrong with a service, when another one still answered. */
  problems: string[];
}

export interface ClipRequest {
  key: string;
  /** What the clip will be used at, so the file can be big enough without being bigger than it has to be. */
  fit: Size;
}

export interface ClipProgress {
  key: string;
  /** Null when the service does not say how big the file is. */
  fraction: number | null;
}

/** What a clip is fetched at when there is no project to match. */
export const DEFAULT_CLIP_SIZE: Size = { width: 1920, height: 1080 };

/** What a clip is watched at before anything is fetched. */
export const PREVIEW_CLIP_SIZE: Size = { width: 640, height: 360 };

const longEdge = (s: Size): number => Math.max(s.width, s.height);

/** The smallest file that is as big as what it is for, or else the biggest there is. */
export function fileFor(files: ClipFile[], want: Size): ClipFile {
  const rising = [...files].sort((a, b) => longEdge(a) - longEdge(b));
  return rising.find((f) => longEdge(f) >= longEdge(want)) ?? rising[rising.length - 1];
}

export function shapeOf(size: Size): Exclude<ClipShape, 'any'> {
  const ratio = size.width / size.height;
  return ratio >= 1.2 ? 'wide' : ratio <= 1 / 1.2 ? 'tall' : 'square';
}

/** Takes from each list in turn, so no service's results bury another's. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/** Text from a service, kept only if it really is a web address. */
export function webAddress(value: unknown): string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

interface ClipParts extends Omit<FreeClip, 'key' | 'width' | 'height' | 'preview'> {
  id: string | number;
}

/** Puts a clip together from what a service said. Null when nothing in it can be played. */
export function makeClip({ id, files, ...parts }: ClipParts): FreeClip | null {
  const usable = files.filter((f) => webAddress(f.url) && f.width > 0 && f.height > 0);
  const pageUrl = webAddress(parts.pageUrl);
  if (!usable.length || !pageUrl) return null;
  const biggest = usable.reduce((a, b) => (longEdge(b) > longEdge(a) ? b : a));
  return {
    ...parts,
    key: `${parts.service}:${id}`,
    width: biggest.width,
    height: biggest.height,
    pageUrl,
    creatorUrl: webAddress(parts.creatorUrl) || null,
    picture: webAddress(parts.picture),
    preview: fileFor(usable, PREVIEW_CLIP_SIZE).url,
    files: usable,
  };
}
