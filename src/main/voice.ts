// Text to speech using the voices built into the operating system:
// SAPI on Windows (through PowerShell) and `say` on macOS. Nothing leaves the computer.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VoiceInfo } from '../shared/types.ts';
import { runFfmpeg, runFfprobe } from './ffmpeg.ts';

function exec(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${bin} exited with code ${code}`))));
  });
}

function powershell(script: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const bin = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand takes the script as data, so nothing the user typed is ever parsed as a command line.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return exec(bin, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], env);
}

const PS_LIST = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
$s.Dispose()
`;

const PS_SPEAK = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$job = Get-Content -LiteralPath $env:VE_TTS_JOB -Raw -Encoding UTF8 | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($job.voice) { $s.SelectVoice([string]$job.voice) }
$s.Rate = [int]$job.rate
foreach ($item in $job.items) {
  $s.SetOutputToWaveFile([string]$item.out)
  $s.Speak([string]$item.text)
}
$s.SetOutputToNull()
$s.Dispose()
`;

let voicesCache: Promise<VoiceInfo[]> | null = null;

export function listVoices(): Promise<VoiceInfo[]> {
  voicesCache ??= (async (): Promise<VoiceInfo[]> => {
    try {
      if (process.platform === 'win32') {
        const out = await powershell(PS_LIST);
        return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
          const [name, lang] = l.split('|');
          return { id: name, name: name.replace(/^Microsoft\s+/, '').replace(/\s+Desktop$/, ''), lang: lang ?? '' };
        });
      }
      if (process.platform === 'darwin') {
        const out = await exec('/usr/bin/say', ['-v', '?']);
        const voices: VoiceInfo[] = [];
        for (const line of out.split('\n')) {
          const m = /^(.+?)\s{2,}([a-z]{2,3}[_-][A-Za-z0-9]+)\s+#/.exec(line);
          if (m) voices.push({ id: m[1].trim(), name: m[1].trim(), lang: m[2].replace('_', '-') });
        }
        return voices;
      }
    } catch {
      // No voices available.
    }
    return [];
  })();
  return voicesCache;
}

/** Speaks each sentence into its own WAV file inside `dir`. `rate` is a speed multiplier (1 = normal). */
async function speakSentences(sentences: string[], voice: string, rate: number, dir: string): Promise<string[]> {
  const files = sentences.map((_, i) => join(dir, `s${i}.wav`));
  if (process.platform === 'win32') {
    // SAPI's rate runs from -10 (a third of the speed) to 10 (three times the speed).
    const sapiRate = Math.max(-10, Math.min(10, Math.round((10 * Math.log(rate)) / Math.log(3))));
    const jobFile = join(dir, 'job.json');
    await writeFile(jobFile, JSON.stringify({ voice, rate: sapiRate, items: sentences.map((text, i) => ({ text, out: files[i] })) }), 'utf8');
    await powershell(PS_SPEAK, { VE_TTS_JOB: jobFile });
  } else if (process.platform === 'darwin') {
    for (let i = 0; i < sentences.length; i++) {
      const textFile = join(dir, `s${i}.txt`);
      await writeFile(textFile, sentences[i], 'utf8');
      await exec('/usr/bin/say', [
        ...(voice ? ['-v', voice] : []), '-r', String(Math.round(180 * rate)),
        '-o', files[i], '--file-format=WAVE', '--data-format=LEI16@44100', '-f', textFile,
      ]);
    }
  } else {
    throw new Error('Text to speech is available on Windows and macOS.');
  }
  return files;
}

/** Pause left between sentences. */
const GAP = 0.3;

/**
 * Speaks a list of sentences into one audio file and reports when each sentence is heard,
 * so subtitles can be timed to the voice.
 */
export async function speakToFile(
  sentences: string[],
  voice: string,
  rate: number,
  dir: string,
): Promise<{ file: string; timings: { start: number; end: number }[] }> {
  const clean = sentences.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) throw new Error('There is no text to speak.');
  const parts = await speakSentences(clean, voice, Math.max(0.5, Math.min(2, rate || 1)), dir);

  const timings: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const part of parts) {
    const d = Number((await runFfprobe(part)).format?.duration) || 0;
    timings.push({ start: cursor, end: cursor + d });
    cursor += d + GAP;
  }

  const file = join(dir, 'voice.wav');
  const inputs = parts.flatMap((p) => ['-i', p]);
  const graph = [
    ...parts.map((_, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=mono,apad=pad_dur=${GAP}[s${i}]`),
    `${parts.map((_, i) => `[s${i}]`).join('')}concat=n=${parts.length}:v=0:a=1[out]`,
  ];
  await runFfmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[out]', file]);
  return { file, timings };
}
