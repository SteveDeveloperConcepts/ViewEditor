// View preferences: how the editor looks on this computer. They are not part of any project.

import { create } from 'zustand';

interface Prefs {
  showSoundwaves: boolean;
  showGhostPlayhead: boolean;
  timelineHeight: number;
}

const KEY = 'vieweditor.prefs';
const DEFAULTS: Prefs = { showSoundwaves: true, showGhostPlayhead: true, timelineHeight: 260 };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

export const usePrefs = create<Prefs>(load);

export function setPrefs(patch: Partial<Prefs>): void {
  usePrefs.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(usePrefs.getState()));
  } catch {
    // Preferences simply will not survive a restart.
  }
}
