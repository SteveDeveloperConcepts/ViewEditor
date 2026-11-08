// The free clips browser: which side of Media is showing, what was searched, and what is downloading.
// It lives outside the panel so the results are still there after looking at another panel.

import { create } from 'zustand';
import type { ClipSearch, ClipServiceStatus, ClipShape, FreeClip, Size } from '@shared/clips';
import type { Asset } from '@shared/types';
import { api, errorMessage } from '@/lib/api';
import { setPanel, useEditor } from './editor';
import { navigate } from './ui';

export type MediaTab = 'mine' | 'free';

interface ClipsState {
  /** The same choice in the editor and on the Media page. */
  tab: MediaTab;
  /** Null until they have been asked for. */
  services: ClipServiceStatus[] | null;
  /** What is typed in the search box, which may not have been searched for yet. */
  text: string;
  shape: ClipShape;
  /** The search the results are from. */
  shown: ClipSearch | null;
  clips: FreeClip[];
  hasMore: boolean;
  searching: boolean;
  /** Why a search did not work. */
  problem: string | null;
  /** What went wrong with one service while another still answered. */
  notes: string[];
  /** Clips being fetched and how far along each is, when that is known. */
  downloads: Record<string, number | null>;
}

const noResults = { shown: null, clips: [], hasMore: false, problem: null, notes: [] };

export const useClips = create<ClipsState>(() => ({ tab: 'mine', services: null, text: '', shape: 'any', searching: false, downloads: {}, ...noResults }));

api.on('clips:progress', ({ key, fraction }) => {
  useClips.setState((s) => (key in s.downloads ? { downloads: { ...s.downloads, [key]: fraction } } : s));
});

export function setMediaTab(tab: MediaTab): void {
  useClips.setState({ tab });
}

export function setClipText(text: string): void {
  useClips.setState({ text });
}

/** Goes to the free clips from wherever you are. */
export function openFreeClips(): void {
  setMediaTab('free');
  if (useEditor.getState().doc) setPanel('media');
  else void navigate({ page: 'assets' });
}

export async function loadClipServices(): Promise<void> {
  useClips.setState({ services: await api.clips.services() });
}

/** Only the newest search may show its results. */
let latest = 0;

async function run(search: ClipSearch, keep: FreeClip[]): Promise<void> {
  const ticket = ++latest;
  useClips.setState({ shown: search, shape: search.shape, searching: true, problem: null, clips: keep });
  try {
    const found = await api.clips.search(search);
    if (ticket !== latest) return;
    const have = new Set(keep.map((c) => c.key));
    useClips.setState({ clips: [...keep, ...found.clips.filter((c) => !have.has(c.key))], hasMore: found.hasMore, notes: found.problems, searching: false });
  } catch (err) {
    if (ticket !== latest) return;
    useClips.setState({ problem: errorMessage(err), hasMore: false, notes: [], searching: false });
  }
}

/** Searches for what is in the box, with anything that has changed. An empty search shows what is popular. */
export function searchClips(change: { query?: string; shape?: ClipShape } = {}): Promise<void> {
  const { text, shape } = useClips.getState();
  return run({ query: change.query ?? text, shape: change.shape ?? shape, page: 1 }, []);
}

export function showMoreClips(): Promise<void> {
  const { shown, clips } = useClips.getState();
  return shown ? run({ ...shown, page: shown.page + 1 }, clips) : Promise.resolve();
}

/** Tries the search that failed again, keeping what earlier pages found. */
export function retryClips(): Promise<void> {
  const { shown, clips } = useClips.getState();
  return shown ? run(shown, shown.page > 1 ? clips : []) : Promise.resolve();
}

/** After connecting or disconnecting, the results may be from a service that has gone, or be missing one that has come. */
export async function clipServicesChanged(): Promise<void> {
  // Looked at first, because the browser starts its own search the moment it appears.
  const hadResults = !!useClips.getState().shown;
  await loadClipServices();
  if (!useClips.getState().services?.some((s) => s.connected)) useClips.setState(noResults);
  else if (hadResults) await searchClips();
}

/** Null when the download was cancelled. */
export async function fetchClip(clip: FreeClip, fit: Size): Promise<Asset | null> {
  useClips.setState((s) => ({ downloads: { ...s.downloads, [clip.key]: null } }));
  try {
    return await api.clips.add({ key: clip.key, fit });
  } finally {
    useClips.setState((s) => {
      const { [clip.key]: _done, ...rest } = s.downloads;
      return { downloads: rest };
    });
  }
}
