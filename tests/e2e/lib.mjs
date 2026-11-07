// Helpers for driving the built app through Playwright's Electron support.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..');
export const media = (name) => join(root, 'tests', 'fixtures', 'media', name);
export const shots = join(here, '.artifacts');
mkdirSync(shots, { recursive: true });
/** The modifier of the app's own shortcuts: Cmd on a Mac, Ctrl elsewhere. */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

export function newDataDir() {
  return mkdtempSync(join(tmpdir(), 'vieweditor-e2e-'));
}

export async function launch(dataDir, extraEnv = {}) {
  // With VIEWEDITOR_E2E_EXE set, the tests drive the packaged app instead of the development build.
  const packaged = process.env.VIEWEDITOR_E2E_EXE;
  const app = await electron.launch({
    ...(packaged ? { executablePath: packaged, args: [] } : { args: [root] }),
    cwd: root,
    env: { ...process.env, VIEWEDITOR_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', ...extraEnv },
  });
  // The app hands web links to the default browser. A test must never open the browser of whoever runs it,
  // so they're only written down, in globalThis.openedExternally.
  await app.evaluate(({ shell }) => {
    globalThis.openedExternally = [];
    shell.openExternal = async (url) => {
      globalThis.openedExternally.push(url);
    };
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await page.waitForSelector('.sidebar, .editor', { timeout: 20000 });
  return { app, page, errors };
}

/** The next file dialogs answer with these paths instead of waiting for a person. */
export async function stubOpenDialog(app, paths) {
  await app.evaluate(({ dialog }, list) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: list });
  }, paths);
}

export async function stubSaveDialog(app, path) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, path);
}

export async function shot(page, name) {
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

let failures = 0;
let passes = 0;

export function check(ok, label, detail = '') {
  if (ok) {
    passes++;
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label} ${detail}`);
    // Shows on the run's summary page on GitHub, which anyone can read without opening the logs.
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${label} ${detail}`.replace(/\s+/g, ' ').slice(0, 500));
  }
}

export function summary(errors) {
  const unexpected = errors.filter((e) => !/Autofill|net::ERR_ABORTED|favicon/.test(e));
  for (const e of unexpected) {
    console.log(`  page error: ${e}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::page error: ${e}`.replace(/\s+/g, ' ').slice(0, 500));
  }
  const result = `${passes} passed, ${failures} failed, ${unexpected.length} page errors`;
  console.log(`\n${result}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice::App test on ${process.platform}: ${result}`);
  return failures + unexpected.length;
}

export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // A temp folder left behind is harmless.
  }
}

/** Reads the library file the way a fresh start would. */
export async function clips(page) {
  return page.$$eval('.clip', (els) =>
    els.map((el) => ({
      id: el.dataset.clip,
      type: el.className.split(' ')[1],
      left: parseFloat(el.style.left),
      top: parseFloat(el.style.top),
      width: parseFloat(el.style.width),
      selected: el.classList.contains('selected'),
    })),
  );
}
