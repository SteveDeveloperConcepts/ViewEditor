// API keys for AI services. They are encrypted with the operating system's credential store and
// stay in the main process: the page only ever learns whether a key exists.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import type { AiProviderId } from '../../shared/ai.ts';

export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class KeyStore {
  private readonly file: string;
  private readonly cipher: Cipher;
  private keys: Partial<Record<AiProviderId, string>> = {};

  constructor(file: string, cipher: Cipher) {
    this.file = file;
    this.cipher = cipher;
  }

  async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
      for (const [id, value] of Object.entries(stored)) {
        this.keys[id as AiProviderId] = this.cipher.decrypt(Buffer.from(value, 'base64'));
      }
    } catch {
      // Keys encrypted on another machine or by another user cannot be read. They just need entering again.
      this.keys = {};
    }
  }

  private async save(): Promise<void> {
    const stored: Record<string, string> = {};
    for (const [id, key] of Object.entries(this.keys)) stored[id] = this.cipher.encrypt(key).toString('base64');
    await writeFile(this.file, JSON.stringify(stored));
  }

  has(id: AiProviderId): boolean {
    return !!this.keys[id];
  }

  get(id: AiProviderId): string | null {
    return this.keys[id] ?? null;
  }

  async set(id: AiProviderId, key: string): Promise<void> {
    if (!this.cipher.available()) throw new Error('This computer cannot store the key securely, so it was not saved.');
    this.keys[id] = key;
    await this.save();
  }

  async remove(id: AiProviderId): Promise<void> {
    delete this.keys[id];
    await this.save();
  }
}
