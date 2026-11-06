// The bridge between the sandboxed page and the main process. It exposes exactly the calls
// listed in shared/api.ts and nothing else: no Node, no file system, no generic IPC.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { API_EVENTS, API_METHODS } from '../shared/api.ts';

const api: Record<string, unknown> = {};

for (const [ns, methods] of Object.entries(API_METHODS)) {
  const group: Record<string, unknown> = {};
  for (const method of methods as string[]) {
    group[method] = (...args: unknown[]) => ipcRenderer.invoke(`${ns}:${method}`, ...args);
  }
  api[ns] = group;
}

api.pathForFile = (file: File): string => {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return '';
  }
};

api.on = (event: string, listener: (payload: unknown) => void): (() => void) => {
  if (!(API_EVENTS as string[]).includes(event)) return () => undefined;
  const wrapped = (_e: unknown, payload: unknown): void => listener(payload);
  ipcRenderer.on(event, wrapped);
  return () => {
    ipcRenderer.removeListener(event, wrapped);
  };
};

contextBridge.exposeInMainWorld('api', api);
