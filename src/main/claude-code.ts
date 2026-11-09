// Optional: asking Claude through Claude Code, installed and signed in on this computer, so the
// request counts toward the user's own Claude plan instead of being billed through the API.
// The app runs the unmodified `claude` program in print mode (`claude -p`) and never sees the
// sign-in: Claude Code keeps that itself.
// Flags and output format: https://code.claude.com/docs/en/cli-reference and .../headless

import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const SETUP_URL = 'https://code.claude.com/docs/en/setup';
const NOT_INSTALLED = `Claude Code is not installed on this computer. Install it (${SETUP_URL}), then run claude in a terminal once to sign in.`;
const NOT_SIGNED_IN = 'Claude Code is not signed in. Run claude in a terminal and sign in with your Claude account.';
const NOT_A_PLAN =
  'Claude Code is signed in with an API key or a cloud provider, so it would bill that rather than your Claude plan. To use your plan, run claude in a terminal, type /login and choose your Claude account.';
const STATUS_TIMEOUT_MS = 30_000;
/** Claude Code's whole prompt. The request itself goes in the instructions file (see askClaudeCode). */
const PROMPT = 'Reply to the request at the end of your instructions.';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where `claude` is: first on the PATH, so it is the one a terminal runs (an older install may linger
 * elsewhere), then where its installers put it, since an app opened from the Dock may not get that PATH.
 */
function findClaude(): string | null {
  const home = homedir();
  const dirs = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const { LOCALAPPDATA, APPDATA } = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          // In each folder the program itself before npm's .cmd wrapper, which only cmd.exe can run.
          ...dirs.flatMap((dir) => [join(dir, 'claude.exe'), join(dir, 'claude.cmd')]),
          join(home, '.local', 'bin', 'claude.exe'),
          ...(LOCALAPPDATA ? [join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'claude.exe')] : []),
          ...(APPDATA ? [join(APPDATA, 'npm', 'claude.cmd')] : []),
        ]
      : [
          ...dirs.map((dir) => join(dir, 'claude')),
          join(home, '.local', 'bin', 'claude'),
          join(home, '.claude', 'local', 'claude'),
          '/opt/homebrew/bin/claude',
          '/usr/local/bin/claude',
        ];
  return candidates.find(isFile) ?? null;
}

/** The app's environment, less what would make Claude Code bill something other than the plan. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // An API key or token here would win over the plan sign-in, and the plan talks to Anthropic itself,
    // not to another base URL. CLAUDECODE marks a Claude Code session (the app started from one with
    // npm run dev), which Claude Code may refuse to start another inside.
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDECODE)$/i.test(name)) continue;
    env[name] = value;
  }
  // Claude Code attaches any file named after an @ in its prompt. The prompt here is a fixed sentence
  // (see askClaudeCode), and versions that have this switch don't read such files at all.
  env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1';
  return env;
}

/** Starts `claude`. An npm install on Windows is a .cmd script, which only cmd.exe can run. */
function launch(exe: string, args: string[], cwd: string): ChildProcess {
  const options = { cwd, env: childEnv(), windowsHide: true };
  if (process.platform === 'win32' && /\.cmd$/i.test(exe)) {
    // Every argument is a flag, a plain word or a path, none containing quotes, so quoting is enough.
    return spawn([exe, ...args].map((part) => `"${part}"`).join(' '), { ...options, shell: true });
  }
  return spawn(exe, args, options);
}

/** Ends a run, including the claude that a .cmd script started on Windows. */
function stop(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill();
  }
}

interface RunOptions {
  cwd: string;
  input?: string;
  timeoutMs: number;
  onLine(line: string): void;
}

/** Runs `claude` with these arguments, passing each line it prints to `onLine`. */
function runClaude(args: string[], options: RunOptions): Promise<{ code: number | null; stderr: string }> {
  const exe = findClaude();
  if (!exe) return Promise.reject(new Error(NOT_INSTALLED));
  return new Promise((resolve, reject) => {
    const child = launch(exe, args, options.cwd);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const timer = setTimeout(() => {
      stop(child);
      settle(() => reject(new Error('Claude Code took too long to answer. Try again.')));
    }, options.timeoutMs);

    const readLines = (final: boolean): void => {
      let newline: number;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (line && !settled) options.onLine(line);
      }
      if (final && stdout.trim() && !settled) options.onLine(stdout.trim());
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      readLines(false);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      settle(() => reject(new Error(missing ? NOT_INSTALLED : `Could not start Claude Code: ${err.message}`)));
    });
    child.on('close', (code) => {
      readLines(true);
      settle(() => resolve({ code, stderr: stderr.trim() }));
    });
    // Claude Code may exit before reading its input, e.g. when it is not signed in.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });
}

/** The last line of `--output-format stream-json`, with only the fields read here. */
interface ResultLine {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
}

/** What Claude Code reported, worded for the user. */
function failure(message: string): string {
  const text = message.trim();
  if (/not logged in|\/login|oauth token|authentication/i.test(text)) return NOT_SIGNED_IN;
  return `Claude Code: ${text.slice(0, 300)}`;
}

export interface ClaudeCodeRequest {
  system: string;
  prompt: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
}

/** Asks Claude Code one question. `refused` is set when the model declined to answer. Errors are worded for the user. */
export async function askClaudeCode(request: ClaudeCodeRequest): Promise<{ text: string; refused: boolean }> {
  // An empty folder to run in, so no project's settings or CLAUDE.md come along, with the instructions in it.
  const dir = await mkdtemp(join(tmpdir(), 'vieweditor-claude-'));
  try {
    const systemFile = join(dir, 'system.md');
    // The request goes in the instructions file too, which Claude Code reads as it is. Its prompt is
    // typed input, where an @ before a path attaches that file from this computer, and a pasted script
    // or the model's own words could hold one. So the prompt is only a fixed sentence.
    await writeFile(systemFile, `${request.system}\n\n<request>\n${request.prompt}\n</request>`, 'utf8');
    const seen: { result?: ResultLine } = {};
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      // These instructions replace Claude Code's own, and it gets no tools, MCP servers or user settings
      // (so no hooks or plugins): it only writes text, and nothing set up for coding runs alongside it.
      '--system-prompt-file', systemFile,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--max-turns', '1',
      '--no-session-persistence',
      '--effort', request.effort,
    ];
    const { code, stderr } = await runClaude(args, {
      cwd: dir,
      input: PROMPT,
      timeoutMs: request.timeoutMs,
      onLine(line) {
        try {
          const message = JSON.parse(line) as ResultLine;
          if (message.type === 'result') seen.result = message;
        } catch {
          // Not a JSON line; only the result matters.
        }
      },
    });
    const { result } = seen;
    if (!result) throw new Error(failure(stderr || `Claude Code stopped without answering (exit code ${code ?? 'none'}).`));
    if (result.stop_reason === 'refusal') return { text: '', refused: true };
    if (result.is_error || result.subtype !== 'success') {
      throw new Error(failure(result.result || result.errors?.join(' ') || stderr || `It stopped early (${result.subtype}).`));
    }
    return { text: result.result ?? '', refused: false };
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
  }
}

/** Resolves when Claude Code is installed and signed in to a Claude plan; otherwise throws a message for the user. */
export async function checkClaudeCode(): Promise<void> {
  // An empty folder of its own, so no settings left in the shared temp folder come along.
  const dir = await mkdtemp(join(tmpdir(), 'vieweditor-claude-'));
  const status = { json: '' };
  let code: number | null;
  try {
    ({ code } = await runClaude(['auth', 'status'], {
      cwd: dir,
      timeoutMs: STATUS_TIMEOUT_MS,
      onLine(line) {
        status.json += `${line}\n`;
      },
    }));
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => undefined);
  }
  let method: string | undefined;
  try {
    method = (JSON.parse(status.json) as { authMethod?: string }).authMethod;
  } catch {
    // Not JSON: the exit code still says whether it is signed in.
  }
  if (code !== 0 || method === 'none') throw new Error(NOT_SIGNED_IN);
  if (method && method !== 'claude.ai' && method !== 'oauth_token') throw new Error(NOT_A_PLAN);
}
