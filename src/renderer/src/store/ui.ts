import type { ReactNode } from 'react';
import { create } from 'zustand';
import type { Asset, ID, ScriptOrigin } from '@shared/types';

export type LibraryView = { kind: 'all' } | { kind: 'space'; spaceId: ID; folderId: ID | null } | { kind: 'trash' };

export type Route =
  | { page: 'script'; prefill?: ScriptOrigin | null }
  | { page: 'library'; view: LibraryView }
  | { page: 'assets' }
  | { page: 'brand' }
  | { page: 'templates' }
  | { page: 'create-asset' }
  /** `add` is media to put on the timeline once the project has opened. */
  | { page: 'editor'; projectId: ID; showAi?: boolean; add?: Asset[] }
  | { page: 'video'; projectId: ID };

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

interface ModalEntry {
  id: number;
  render: (close: (result?: unknown) => void) => ReactNode;
  resolve: (result: unknown) => void;
}

interface UiState {
  route: Route;
  toasts: Toast[];
  modals: ModalEntry[];
}

export const useUi = create<UiState>(() => ({
  route: { page: 'script' },
  toasts: [],
  modals: [],
}));

let nextId = 1;

/** Hooks that must run before leaving the current page (the editor saves here). */
const leaveGuards = new Set<() => Promise<void>>();

export function onLeave(guard: () => Promise<void>): () => void {
  leaveGuards.add(guard);
  return () => leaveGuards.delete(guard);
}

export async function navigate(route: Route): Promise<void> {
  for (const guard of [...leaveGuards]) await guard().catch(() => undefined);
  useUi.setState({ route });
}

export function toast(text: string, opts: { kind?: Toast['kind']; action?: Toast['action']; duration?: number } = {}): void {
  const id = nextId++;
  const entry: Toast = { id, kind: opts.kind ?? 'info', text, action: opts.action };
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), entry] }));
  setTimeout(() => dismissToast(id), opts.duration ?? (opts.kind === 'error' ? 8000 : opts.action ? 7000 : 4000));
}

export function dismissToast(id: number): void {
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Shows a modal and resolves with whatever it was closed with (undefined when dismissed). */
export function showModal<T>(render: (close: (result?: T) => void) => ReactNode): Promise<T | undefined> {
  return new Promise((resolve) => {
    const id = nextId++;
    const entry: ModalEntry = {
      id,
      render: render as ModalEntry['render'],
      resolve: (result) => {
        useUi.setState((s) => ({ modals: s.modals.filter((m) => m.id !== id) }));
        resolve(result as T | undefined);
      },
    };
    useUi.setState((s) => ({ modals: [...s.modals, entry] }));
  });
}
