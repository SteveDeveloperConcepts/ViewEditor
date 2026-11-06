// Publish a release: raise the version in package.json, commit it, tag it with the release notes and push
// both, which starts the Release workflow (docs/RELEASING.md). Run it from the project folder:
//   npm run release -- <version> "<what changed>" ["<what changed>" …] [--dry-run]
// Each quoted argument becomes one line under "What's new". --dry-run checks everything and shows the
// plan without changing anything.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const usage = 'Usage: npm run release -- <version> "<what changed>" ["<what changed>" …] [--dry-run]';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [version, ...noteArgs] = args.filter((arg) => arg !== '--dry-run');

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function git(...gitArgs) {
  const result = spawnSync('git', gitArgs, { encoding: 'utf8' });
  if (result.error) fail(`Couldn't run git: ${result.error.message}`);
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function gitOrFail(...gitArgs) {
  const result = git(...gitArgs);
  if (!result.ok) fail(`git ${gitArgs[0]} failed:\n${result.err}`);
  return result.out;
}

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`${version ? `"${version}" isn't a version like 1.4.0.` : 'Give the new version.'}\n  ${usage}`);
}
// One item per argument (or per line of one), shown as bullets under "What's new".
const items = noteArgs
  .flatMap((arg) => arg.split(/\r?\n/))
  .map((line) => line.trim().replace(/^[-*]\s+/, ''))
  .filter(Boolean);
if (items.length === 0) fail(`Say what changed in this release, one quoted line per change.\n  ${usage}`);
const placeholder = items.find((item) => /^<.*>$/.test(item));
if (placeholder) fail(`"${placeholder}" is the placeholder from the docs. Describe what actually changed.`);

// Every check passes before anything changes.
const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
if (!branch.ok) fail('Check out a branch first: HEAD is detached.');
const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
if (!upstream.ok) fail(`${branch.out} isn't linked to a remote branch yet. Push it once first.`);
const remote = gitOrFail('config', `branch.${branch.out}.remote`);
const remoteBranch = upstream.out.slice(remote.length + 1);
if (gitOrFail('status', '--porcelain', '--untracked-files=no')) {
  fail('Commit or discard your uncommitted changes first, so the release is exactly what is committed.');
}

const packagePath = path.resolve('package.json');
const packageText = fs.readFileSync(packagePath, 'utf8');
const pkg = JSON.parse(packageText);
if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '')) fail('package.json has no version like 1.4.0 to raise.');
const numbers = (text) => text.split('.').map(Number);
const order =
  numbers(version)
    .map((part, index) => part - (numbers(pkg.version)[index] ?? 0))
    .find((difference) => difference !== 0) ?? 0;
if (order < 0) fail(`${version} is lower than the current version, ${pkg.version}.`);
// The same version as package.json: it was raised already (say, by a run whose push failed), so only tag.
const bump = order > 0;
const tag = `v${version}`;

if (git('rev-parse', '--quiet', '--verify', `refs/tags/${tag}`).ok) {
  fail(`This computer already has a tag ${tag}. If it's from a release attempt that failed, delete it with: git tag -d ${tag}`);
}
console.log(`Checking ${remote}…`);
// Branches only: fetching tags would bring back a failed attempt's tag that was just deleted here.
gitOrFail('fetch', '--quiet', '--no-tags', remote);
if (git('ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`).ok) {
  fail(`${tag} is already on ${remote}. If its build failed and nothing was published, delete it with\n  git push ${remote} :refs/tags/${tag}\n  then run this again.`);
}
const behind = Number(gitOrFail('rev-list', '--count', 'HEAD..@{upstream}'));
if (behind > 0) fail(`${upstream.out} has ${behind} commit${behind === 1 ? '' : 's'} that ${branch.out} doesn't. Pull first.`);

const message = `${pkg.productName ?? pkg.name} ${version}\n\n${items.map((item) => `- ${item}`).join('\n')}\n`;
const steps = [
  ...(bump ? [`raise the version in package.json from ${pkg.version} to ${version} and commit it`] : []),
  `tag ${tag}`,
  `push both to ${upstream.out}`,
];
console.log(`\nThis will ${steps.join(', ')}. Release notes:\n\n${message}`);
if (dryRun) {
  console.log('Dry run: nothing was changed.');
  process.exit(0);
}

if (bump) {
  fs.writeFileSync(packagePath, packageText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
  gitOrFail('commit', '--quiet', '-m', `Release ${version}`, '--', 'package.json');
}
const messageFile = path.join(os.tmpdir(), `vieweditor-release-${process.pid}.txt`);
fs.writeFileSync(messageFile, message);
try {
  gitOrFail('tag', '--annotate', '--file', messageFile, tag);
} finally {
  fs.rmSync(messageFile, { force: true });
}

// Atomic: GitHub gets the commit and the tag together, or neither.
const pushArgs = ['push', '--atomic', remote, `HEAD:refs/heads/${remoteBranch}`, `refs/tags/${tag}`];
console.log(`Pushing to ${remote}…`);
if (spawnSync('git', pushArgs, { stdio: 'inherit' }).status !== 0) {
  fail(`The push failed, so nothing was published. The ${bump ? 'commit and the ' : ''}tag are on this computer.\n  Fix the problem above, then push them with: git ${pushArgs.join(' ')}`);
}

const github = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(gitOrFail('remote', 'get-url', remote))?.[1];
console.log(`\n✔ Pushed ${tag}. The Release workflow tests, builds and publishes it.`);
if (github) console.log(`  Progress: https://github.com/${github}/actions\n  Release:  https://github.com/${github}/releases/tag/${tag}`);
