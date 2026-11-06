// Preview playback. The playhead in the editor store is the clock; this module moves it while
// playing and keeps every <video>/<audio> element on the stage lined up with it.

import { AUDIO_FADE_SECONDS } from '@shared/render';
import { snapToFrame } from '@shared/time';
import { isTimed, itemEnd, projectDuration } from '@shared/timeline';
import type { ID, MediaItem } from '@shared/types';
import { timelineEnd, useEditor } from '@/store/editor';

const media = new Map<ID, HTMLMediaElement>();
const visuals = new Map<ID, HTMLElement>();

let raf = 0;
let wallStart = 0;
let headStart = 0;
let syncQueued = false;

const EDGE = 1e-4;

function onSeeked(): void {
  // While scrubbing, a seek can finish after the playhead has already moved on.
  if (!useEditor.getState().playing) requestSync();
}

/** Called by the stage when a media element for a timeline item mounts (el) or unmounts (null). */
export function registerMedia(id: ID, el: HTMLMediaElement | null): void {
  const previous = media.get(id);
  if (previous && previous !== el) {
    previous.removeEventListener('seeked', onSeeked);
    previous.removeEventListener('loadeddata', onSeeked);
    previous.pause();
  }
  if (el) {
    media.set(id, el);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadeddata', onSeeked);
    requestSync();
  } else {
    media.delete(id);
  }
}

/** Called by the stage for anything that should only be visible while its item is on screen. */
export function registerVisual(id: ID, el: HTMLElement | null): void {
  if (el) {
    visuals.set(id, el);
    requestSync();
  } else {
    visuals.delete(id);
  }
}

function fadeGain(it: MediaItem, t: number): number {
  if (!it.fadeAudio) return 1;
  const f = Math.min(AUDIO_FADE_SECONDS, it.duration / 2);
  if (f <= 0) return 1;
  const local = t - it.start;
  return Math.max(0, Math.min(1, local / f, (it.duration - local) / f));
}

function sync(): void {
  const s = useEditor.getState();
  const doc = s.doc;
  if (!doc) return;
  const t = s.playhead;
  const byId = new Map(doc.items.map((it) => [it.id, it]));

  for (const [id, el] of visuals) {
    const it = byId.get(id);
    const visible = !!it && t >= it.start - EDGE && t < itemEnd(it) - EDGE ? 'visible' : 'hidden';
    if (el.style.visibility !== visible) el.style.visibility = visible;
  }

  for (const [id, el] of media) {
    const it = byId.get(id);
    if (!it || !isTimed(it)) {
      if (!el.paused) el.pause();
      continue;
    }
    const active = t >= it.start - EDGE && t < itemEnd(it) - EDGE;
    if (!active) {
      if (!el.paused) el.pause();
      // Cue up clips that are about to start so their first frame is ready when the playhead arrives.
      const lead = it.start - t;
      if (lead > 0 && lead < 2 && !el.seeking && Math.abs(el.currentTime - it.trimStart) > 0.05) el.currentTime = it.trimStart;
      continue;
    }
    const target = it.trimStart + (t - it.start) * it.speed;
    if (el.playbackRate !== it.speed) el.playbackRate = it.speed;
    if (el.muted !== it.muted) el.muted = it.muted;
    const volume = Math.max(0, Math.min(1, it.volume * fadeGain(it, t)));
    if (Math.abs(el.volume - volume) > 0.005) el.volume = volume;

    if (s.playing) {
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        void el.play().catch(() => undefined);
      } else if (Math.abs(el.currentTime - target) > 0.35) {
        el.currentTime = target;
      }
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && Math.abs(el.currentTime - target) > 0.012) el.currentTime = target;
    }
  }
}

function requestSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    sync();
  });
}

function tick(now: number): void {
  const s = useEditor.getState();
  if (!s.playing || !s.doc) return;
  const end = projectDuration(s.doc);
  const t = headStart + (now - wallStart) / 1000;
  if (t >= end) {
    useEditor.setState({ playhead: end, playing: false });
    sync();
    return;
  }
  useEditor.setState({ playhead: t });
  sync();
  raf = requestAnimationFrame(tick);
}

export function play(): void {
  const s = useEditor.getState();
  if (!s.doc || s.playing) return;
  const end = projectDuration(s.doc);
  if (end <= 0) return;
  // Pressing play at the end starts over.
  headStart = s.playhead >= end - 0.5 / s.doc.settings.fps ? 0 : s.playhead;
  wallStart = performance.now();
  useEditor.setState({ playing: true, playhead: headStart });
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function pause(): void {
  const s = useEditor.getState();
  if (!s.playing) return;
  cancelAnimationFrame(raf);
  useEditor.setState({ playing: false, playhead: s.doc ? snapToFrame(s.playhead, s.doc.settings.fps) : s.playhead });
  sync();
}

export function togglePlay(): void {
  if (useEditor.getState().playing) pause();
  else play();
}

export function seek(time: number): void {
  const s = useEditor.getState();
  if (!s.doc) return;
  const t = Math.max(0, Math.min(time, timelineEnd(s.doc)));
  if (s.playing) {
    headStart = t;
    wallStart = performance.now();
  }
  useEditor.setState({ playhead: t });
}

/** Moves the playhead by whole frames (the skip buttons and the arrow keys). */
export function stepFrames(frames: number): void {
  const s = useEditor.getState();
  if (!s.doc) return;
  pause();
  const fps = s.doc.settings.fps;
  seek(snapToFrame(useEditor.getState().playhead, fps) + frames / fps);
}

// Whenever the document or the playhead changes while paused, bring the media elements along.
useEditor.subscribe((s, prev) => {
  if (!s.playing && (s.doc !== prev.doc || s.playhead !== prev.playhead || s.playing !== prev.playing)) requestSync();
});

// Animation frames stop while the window is hidden, which would let the clock run away from the media.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
