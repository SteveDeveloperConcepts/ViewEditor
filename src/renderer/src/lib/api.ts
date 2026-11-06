import type { Api } from '@shared/api';

export const api: Api = window.api;

/** Human-readable text of an error, without the wrapper Electron adds to failed IPC calls. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '');
}

/** Ctrl on Windows and Linux, Command on macOS. */
export function isMod(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
}

export const MOD_LABEL = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

/** True while the user is typing somewhere, so single-key shortcuts must stay out of the way. */
export function isTyping(target: EventTarget | null = document.activeElement): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['range', 'checkbox', 'radio', 'button', 'color', 'file'].includes(type);
}
