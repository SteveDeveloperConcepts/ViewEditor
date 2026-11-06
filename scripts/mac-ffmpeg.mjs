// Puts an FFmpeg we are allowed to pass on into Mac builds.
//
// npm installs FFmpeg through ffmpeg-ffprobe-static, whose Mac binaries were compiled with
// --enable-nonfree. FFmpeg defines those as not redistributable, so they must never ship. Mac builds use
// Jellyfin's GPL builds instead, which are static and built in public (licenses/FFMPEG.md has the links).
//
// electron-builder runs this before packing each Mac architecture (`beforePack` in electron-builder.yml),
// so a Mac build cannot contain the other binaries. To test against what ships, run it by hand:
//   npm run mac:ffmpeg [arm64|x64]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '8.1.3-2';
const BUILDS = {
  arm64: { name: 'macarm64', sha256: 'd898cc819e7c4e9219d6410ddbdaada0838f14bec6ff89e283639915394cb43f' },
  x64: { name: 'mac64', sha256: 'd394180f1155f84857544a48a99869f5741ccc50c5a1f73d2797429a2b326448' },
};
const TOOLS = ['ffmpeg', 'ffprobe'];
/** electron-builder's numbers for the two architectures. */
const BUILDER_ARCH = { 1: 'x64', 3: 'arm64' };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Fetches one build, unless an earlier run already did, and returns the folder holding its tools. */
async function fetchBuild(arch) {
  const build = BUILDS[arch];
  if (!build) throw new Error(`There is no Mac FFmpeg for "${arch}". Use arm64 or x64.`);
  const dir = join(root, 'node_modules', '.cache', 'vieweditor-ffmpeg', `${VERSION}-${arch}`);
  if (TOOLS.every((tool) => existsSync(join(dir, tool)))) return dir;

  const file = `jellyfin-ffmpeg_${VERSION}_portable_${build.name}-gpl.tar.xz`;
  const url = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${VERSION}/${file}`;
  console.log(`Downloading ${file}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== build.sha256) throw new Error(`${file} is not the file this project was checked against. Its SHA-256 is ${sha256}.`);

  // Unpacked beside the final folder and moved in whole, so a failed run leaves nothing half-finished.
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, file), data);
  const tar = spawnSync('tar', ['-xJf', file, ...TOOLS], { cwd: partial, stdio: 'inherit' });
  if (tar.status !== 0) throw new Error(`Could not unpack ${file}.`);
  rmSync(join(partial, file));
  for (const tool of TOOLS) {
    if (readFileSync(join(partial, tool)).includes('--enable-nonfree')) throw new Error(`${file} contains a non-free ${tool}, which cannot ship.`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return dir;
}

/** Replaces the npm package's binaries with the ones for this architecture. */
export async function installMacFfmpeg(arch, into = join(root, 'node_modules', 'ffmpeg-ffprobe-static')) {
  const from = await fetchBuild(arch);
  for (const tool of TOOLS) {
    copyFileSync(join(from, tool), join(into, tool));
    chmodSync(join(into, tool), 0o755);
  }
  console.log(`Using Jellyfin FFmpeg ${VERSION} (${arch}).`);
}

/** electron-builder's beforePack hook. */
export default async function beforePack({ electronPlatformName, arch }) {
  if (electronPlatformName === 'darwin') await installMacFfmpeg(BUILDER_ARCH[arch] ?? String(arch));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await installMacFfmpeg(process.argv[2] ?? process.arch);
}
