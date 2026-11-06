// How a copy of the app gets new versions from GitHub releases. Kept free of Electron so it can be tested.

/** A newer version found since the app started. */
export interface UpdateState {
  /** `ready`: downloaded, and installs on restart. `available`: out, and has to be fetched by hand. */
  kind: 'ready' | 'available';
  version: string;
}

/**
 * - `install`: download in the background and install on restart (the Windows installer).
 * - `notify`: say a new version is out and link to it. macOS only installs updates signed with a
 *   Developer ID, and the Mac builds have only an ad-hoc signature.
 * - null: neither. Development runs and test runs never check.
 */
export function updateMode(env: { packaged: boolean; platform: string; testing: boolean }): 'install' | 'notify' | null {
  if (!env.packaged || env.testing) return null;
  if (env.platform === 'win32') return 'install';
  if (env.platform === 'darwin') return 'notify';
  return null;
}
