// Finds new versions on GitHub releases. Installed copies learn where to look from `publish` in
// electron-builder.yml; the address here is only for the release page of a version a copy can't install
// itself.

import { app, autoUpdater as squirrel, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { updateMode, type UpdateState } from '../shared/update.ts';

const RELEASES = 'https://github.com/SteveDeveloperConcepts/ViewEditor/releases';
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

export interface Updater {
  /** What the update notice shows, or null. */
  state(): UpdateState | null;
  /** `ready`: quit and install it. `available`: open its release page. `move`: move the app to Applications, which restarts it. */
  install(): void;
}

/** Checks GitHub for a newer version shortly after starting, then every few hours. */
export function setupUpdater(announce: (state: UpdateState) => void): Updater {
  const mac = process.platform === 'darwin';
  const inApplications = mac && app.isPackaged && app.isInApplicationsFolder();
  const mode = updateMode({ packaged: app.isPackaged, platform: process.platform, testing: !!process.env.VIEWEDITOR_DATA_DIR, inApplications });
  if (!mode) return { state: () => null, install: () => undefined };

  // Until a newer version turns up, a Mac copy that can't update itself asks to be moved to Applications.
  let current: UpdateState | null = mac && !inApplications ? { kind: 'move' } : null;
  /** A version Squirrel.Mac wouldn't install, so it isn't offered as ready again. */
  let refused: string | null = null;
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
  autoUpdater.on('update-downloaded', (info) => {
    if (info.version !== refused) found({ kind: 'ready', version: info.version });
  });
  if (mac) {
    // Squirrel.Mac installs Mac updates from the release's zip. It checks that a download is signed with the
    // same Developer ID as this copy, and that it can replace this copy, only after the download is
    // announced as ready. When it refuses (a build without the certificate, or a copy in a folder this
    // account can't change), offer the release page rather than a restart that would change nothing.
    squirrel.on('error', () => {
      if (current?.kind !== 'ready') return;
      refused = current.version;
      found({ kind: 'available', version: current.version });
    });
  }

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
      if (current?.kind === 'ready') {
        // Silent, then start the new version. The Windows installer already knows where the app is
        // installed, and on macOS Squirrel.Mac replaces the app where it is.
        autoUpdater.quitAndInstall(true, true);
      } else if (current?.kind === 'available') {
        void shell.openExternal(`${RELEASES}/tag/v${current.version}`);
      } else if (current?.kind === 'move') {
        // Copies the app into Applications, replacing an older copy there, then quits and opens the new
        // copy. It does nothing if the person cancels the password prompt an account without admin rights
        // gets, and throws if the copy fails.
        app.moveToApplicationsFolder();
      }
    },
  };
}
