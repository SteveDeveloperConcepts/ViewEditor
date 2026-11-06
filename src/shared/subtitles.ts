// Subtitle files and script text. Pure functions, shared by the editor and the tests.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseStamp(text: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const [, h, min, s, frac] = m;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000;
}

/** Reads SRT or WebVTT. Blocks that are not cues (headers, notes, styles) are skipped. */
export function parseSubtitles(source: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const [from, rest] = lines[timing].split('-->');
    const start = parseStamp(from);
    // WebVTT may put cue settings after the end time.
    const end = parseStamp((rest ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null || end <= start) continue;
    const text = lines
      .slice(timing + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function stamp(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
}

const ABBREVIATIONS = /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|vs|etc|e\.g|i\.e|no|inc|ltd|jr|sr)\.$/i;

/** Breaks a script into spoken sentences. Line breaks always end a sentence. */
export function splitSentences(script: string): string[] {
  const out: string[] = [];
  for (const line of script.split(/\n+/)) {
    let buffer = '';
    const parts = line.split(/(?<=[.!?…]["')\]]?)\s+/);
    for (const part of parts) {
      buffer = buffer ? `${buffer} ${part}` : part;
      if (ABBREVIATIONS.test(buffer)) continue;
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}

/**
 * Splits a timed sentence into cues short enough to read on screen, breaking at natural pauses
 * where possible. Each piece gets a share of the time proportional to its length.
 */
export function chunkCue(text: string, start: number, end: number, maxChars = 62): Cue[] {
  const words = text.split(/\s+/).filter(Boolean);
  const pieces: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (next.length > maxChars && line) {
      pieces.push(line);
      line = words[i];
    } else {
      line = next;
    }
    // A comma past the halfway mark is a good place to break.
    if (/[,;:]$/.test(words[i]) && line.length > maxChars * 0.55 && i < words.length - 1) {
      pieces.push(line);
      line = '';
    }
  }
  if (line) pieces.push(line);

  // One word left alone on the last line reads badly, so the line before lends it another.
  const last = pieces.length - 1;
  if (last > 0 && !pieces[last].includes(' ')) {
    const before = pieces[last - 1].split(' ');
    if (before.length > 2) {
      pieces[last] = `${before.pop()} ${pieces[last]}`;
      pieces[last - 1] = before.join(' ');
    }
  }

  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  let cursor = start;
  return pieces.map((piece, i) => {
    const pieceEnd = i === pieces.length - 1 ? end : cursor + ((end - start) * piece.length) / total;
    const cue = { start: cursor, end: pieceEnd, text: piece };
    cursor = pieceEnd;
    return cue;
  });
}
