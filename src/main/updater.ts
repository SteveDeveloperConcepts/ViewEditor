// Finds new versions on GitHub releases. Installed copies learn where to look from `publish` in
// electron-builder.yml; the address here is only for the release page the macOS notice opens.

import { app, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { updateMode, type UpdateState } from '../shared/update.ts';

const RELEASES = 'https://github.com/SteveDeveloperConcepts/ViewEditor/releases';
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface Updater {
  /** The newer version found since the app started, or null. */
  state(): UpdateState | null;
  /** `ready`: quit and install it. `available`: open its release page. */
  install(): void;
}

/** Checks GitHub for a newer version shortly after starting, then every few hours. */
export function setupUpdater(announce: (state: UpdateState) => void): Updater {
  const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, testing: !!process.env.VIEWEDITOR_DATA_DIR });
  if (!mode) return { state: () => null, install: () => undefined };

  let current: UpdateState | null = null;
  const found = (state: UpdateState): void => {
    current = state;
    announce(state);
  };

  autoUpdater.autoDownload = mode === 'install';
  // electron-updater sends a random ID kept for this install, for staged rollouts. Releases here are not
  // staged, and nothing sent should tell one user from another.
  autoUpdater.requestHeaders = { 'x-user-staging-id': '' };
  // Offline, GitHub unreachable or no release yet: the next check tries again.
  autoUpdater.on('error', () => undefined);
  autoUpdater.on('update-available', (info) => {
    if (mode === 'notify') found({ kind: 'available', version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => found({ kind: 'ready', version: info.version }));

  // A download can outlast the interval, so never start a second one alongside it.
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      await result?.downloadPromise;
    } catch {
      // Reported through the error event.
    } finally {
      checking = false;
    }
  };
  setTimeout(() => void check(), FIRST_CHECK_MS).unref();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();

  return {
    state: () => current,
    install: () => {
      // Silent, then start the new version: the installer already knows where the app is installed.
      if (current?.kind === 'ready') autoUpdater.quitAndInstall(true, true);
      else if (current?.kind === 'available') void shell.openExternal(`${RELEASES}/tag/v${current.version}`);
    },
  };
}
