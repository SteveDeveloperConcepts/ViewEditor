// How a copy of the app gets new versions from GitHub releases. Kept free of Electron so it can be tested.

/**
 * What the update notice shows:
 * - `ready`: a newer version has downloaded, and installs on restart.
 * - `available`: a newer version is out, and has to be fetched by hand.
 * - `move`: this Mac copy can't update itself where it is, such as on the disk image, until it's moved to
 *   Applications.
 */
export type UpdateState = { kind: 'ready' | 'available'; version: string } | { kind: 'move' };

/**
 * - `install`: download in the background and install on restart. The Windows installer, and a Mac copy in
 *   Applications: releases are signed with a Developer ID, and macOS installs an update signed like the copy
 *   it replaces.
 * - `notify`: say a new version is out and link to it. macOS can't replace a copy anywhere else, such as one
 *   on the disk image, or one it runs from a hidden copy because it was opened straight from Downloads.
 * - null: neither. Development runs and test runs never check.
 *
 * Mac copies of 0.2.0 and earlier have only an ad-hoc signature and notify wherever they are, so their users
 * install the first signed version by hand.
 */
export function updateMode(env: { packaged: boolean; platform: string; testing: boolean; inApplications?: boolean }): 'install' | 'notify' | null {
  if (!env.packaged || env.testing) return null;
  if (env.platform === 'win32') return 'install';
  if (env.platform === 'darwin') return env.inApplications ? 'install' : 'notify';
  return null;
}
