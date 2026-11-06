// Optional: drafting a narration script from a topic with the Claude API.
// Nothing here runs unless the user asks for a script. The API key is supplied by the user,
// encrypted with the operating system's credential store, and never sent to the renderer.

import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import { safeStorage } from 'electron';
import { SCRIPT_MAX_CHARS } from '../shared/constants.ts';
import type { ScriptBrief } from '../shared/types.ts';

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You write narration scripts for short videos. The script is read aloud by a text-to-speech voice and shown on screen as subtitles, one sentence at a time.

Write only the words to be spoken: no title, no headings, no speaker labels, no stage directions, no markdown and no emoji. Use plain sentences that sound natural when spoken, and keep each sentence under about 25 words so it fits on screen as a subtitle. Spell out anything a synthetic voice would stumble on, for example "percent" rather than "%". Open with a line that earns attention and finish with a clear closing line.`;

export class ScriptWriter {
  private readonly keyFile: string;

  constructor(keyFile: string) {
    this.keyFile = keyFile;
  }

  hasKey(): boolean {
    return existsSync(this.keyFile);
  }

  async setKey(key: string | null): Promise<void> {
    const trimmed = key?.trim();
    if (!trimmed) {
      await rm(this.keyFile, { force: true });
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot store the key securely, so it was not saved.');
    await writeFile(this.keyFile, safeStorage.encryptString(trimmed));
  }

  /** Uses the saved key when there is one; otherwise the SDK looks for credentials in the environment. */
  private async client(): Promise<Anthropic> {
    const options = { timeout: 120_000 };
    if (!this.hasKey()) return new Anthropic(options);
    return new Anthropic({ ...options, apiKey: safeStorage.decryptString(await readFile(this.keyFile)) });
  }

  /** Turns narration into one visual prompt per scene. Returns null if that does not work out, so the caller can fall back. */
  async writeScenePrompts(scenes: string[], topic: string): Promise<string[] | null> {
    try {
      const client = await this.client();
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system:
          'You write prompts for an AI video generator. Each prompt describes one short shot: subject, setting, action, camera and light, in one sentence of plain description. Keep a consistent look across the shots so they cut together. Describe what is seen, never what is said, and do not ask for any words or captions on screen. Reply with exactly one prompt per line and nothing else: no numbering, no blank lines.',
        messages: [
          {
            role: 'user',
            content: `${topic ? `The video is about: ${topic}\n\n` : ''}Write ${scenes.length} prompts, one for each of these moments of narration:\n\n${scenes.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
          },
        ],
      });
      if (response.stop_reason === 'refusal') return null;
      let text = '';
      for (const block of response.content) if (block.type === 'text') text += block.text;
      const lines = text.split('\n').map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
      return lines.length === scenes.length ? lines : null;
    } catch {
      return null;
    }
  }

  async writeScript(topic: string, targetSeconds: number, brief?: ScriptBrief): Promise<string> {
    const subject = topic.trim();
    if (!subject) throw new Error('Describe what the video should be about first.');
    const seconds = Math.max(10, Math.min(300, Math.round(targetSeconds) || 30));
    // Narration runs at roughly 145 words a minute.
    const words = Math.round(seconds * 2.4);
    const aims = [
      brief?.videoType && `Kind of video: ${brief.videoType}`,
      brief?.audience && `Audience: ${brief.audience}`,
      brief?.tone && `Tone of voice: ${brief.tone}`,
      brief?.platform && `Platform: ${brief.platform}`,
    ].filter(Boolean);

    let response: Anthropic.Beta.BetaMessage;
    try {
      const client = await this.client();
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // If a safety classifier declines the request, the API retries it on its recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Write the narration for a video about:\n\n${subject}\n\n${aims.length ? `${aims.join('\n')}\n\n` : ''}Aim for about ${words} words, which is roughly ${seconds} seconds when read aloud.`,
          },
        ],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new Error('The Anthropic API key was not accepted. Check it under AI connections.');
      }
      if (err instanceof Anthropic.RateLimitError) throw new Error('The Anthropic API is rate limiting this key right now. Try again in a moment.');
      if (err instanceof Anthropic.APIConnectionError) throw new Error('Could not reach the Anthropic API. Check your internet connection.');
      if (err instanceof Anthropic.APIError) throw new Error(`The Anthropic API returned an error (${err.status ?? 'unknown'}): ${err.message}`);
      // With no saved key, this is the SDK finding no credentials to send.
      if (!this.hasKey()) throw new Error('Add an Anthropic API key under AI connections to write scripts from a topic, or paste your own script instead.');
      throw err;
    }

    if (response.stop_reason === 'refusal') throw new Error('The model declined to write a script for this topic. Try describing it differently.');
    let text = '';
    for (const block of response.content) if (block.type === 'text') text += block.text;
    text = text.trim();
    if (!text) throw new Error('No script came back. Try again.');
    if (text.length > SCRIPT_MAX_CHARS) {
      // Scripts are capped at 5,000 characters; cut at the last full sentence that fits.
      const cut = text.slice(0, SCRIPT_MAX_CHARS);
      const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      text = end > SCRIPT_MAX_CHARS * 0.5 ? cut.slice(0, end + 1) : cut;
    }
    return text;
  }
}
