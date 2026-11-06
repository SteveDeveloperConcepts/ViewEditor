export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function newId(prefix = ''): string {
  const raw = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 00:05.3 — the timeline readout (minutes:seconds.tenths, hours only when needed). */
export function formatTimecode(t: number): string {
  const total = Math.max(0, Math.round(t * 10) / 10);
  const tenths = Math.round(total * 10) % 10;
  const whole = Math.floor(total + 1e-9);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return `${h > 0 ? `${h}:` : ''}${pad2(m)}:${pad2(s)}.${tenths}`;
}

/** 0:05 — compact clock for badges and ranges. */
export function formatClock(t: number): string {
  const whole = Math.max(0, Math.round(t));
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Parses "1:02:03.5", "02:03.5", "3.5" → seconds. Returns null when it is not a time. */
export function parseTimecode(text: string): number | null {
  const s = text.trim().replace(',', '.');
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  let total = 0;
  for (const p of parts) total = total * 60 + p;
  return Number.isFinite(total) ? total : null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function formatRelative(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
