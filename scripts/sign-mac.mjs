// Signs the Mac apps for electron-builder (`sign` in electron-builder.yml) the way it would itself, except
// for FFmpeg and FFprobe.
//
// electron-builder gives every program in the app other than the app itself Electron's entitlements,
// build/entitlements.mac.plist. They loosen the hardened runtime: they let a program generate code as it
// runs, load libraries that aren't signed by Apple or by us, and use the camera and microphone. Electron's
// helpers need that. FFmpeg and FFprobe don't, and they read every file people import, so they're the
// programs most worth keeping locked down. They get build/entitlements.ffmpeg.plist instead, which allows
// nothing. Like everything else in the app, they're still signed with the Developer ID (or ad hoc, with
// build/adhoc-mac.yml), the hardened runtime and a secure timestamp, which notarisation requires of every
// program in it.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FFMPEG_ENTITLEMENTS = join(root, 'build', 'entitlements.ffmpeg.plist');

/** Where FFmpeg and FFprobe are in an app: unpacked from the asar archive, where src/main/ffmpeg.ts runs them. */
export function ffmpegTools(app) {
  const folder = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-ffprobe-static');
  return [join(folder, 'ffmpeg'), join(folder, 'ffprobe')];
}

/** electron-builder's signing options, with FFmpeg's own entitlements. Everything else is left as it was. */
export function withFfmpegEntitlements(options) {
  const tools = new Set(ffmpegTools(options.app).map((file) => resolve(file)));
  const forFile = options.optionsForFile;
  return {
    ...options,
    optionsForFile(file) {
      const fileOptions = forFile ? forFile(file) : {};
      return tools.has(resolve(file)) ? { ...fileOptions, entitlements: FFMPEG_ENTITLEMENTS } : fileOptions;
    },
  };
}

/** The copy of @electron/osx-sign that electron-builder signs with when it signs by itself. */
function osxSign() {
  const builder = dirname(require.resolve('electron-builder'));
  const builderLib = dirname(require.resolve('app-builder-lib', { paths: [builder] }));
  return require(require.resolve('@electron/osx-sign', { paths: [builderLib] }));
}

export default async function signMac(options) {
  // Without this, a change to where FFmpeg is packed would quietly give it Electron's entitlements again.
  const missing = ffmpegTools(options.app).filter((file) => !existsSync(file));
  if (missing.length > 0) throw new Error(`FFmpeg isn't where the app runs it from:\n  ${missing.join('\n  ')}`);

  const { signAsync } = osxSign();
  const signOptions = withFfmpegEntitlements(options);
  // Apple's timestamp server sometimes turns a request away, so try again, as electron-builder does.
  for (let attempt = 1; ; attempt++) {
    try {
      return await signAsync(signOptions);
    } catch (error) {
      if (attempt === 4) throw error;
      console.warn(`Signing failed, trying again in ${attempt * 5} seconds: ${error.message}`);
      await new Promise((done) => setTimeout(done, attempt * 5000));
    }
  }
}
