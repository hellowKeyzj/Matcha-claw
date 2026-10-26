import { Ability } from '@serenity-js/core';
import { lstat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { licensedProfileRoot } from '../config/electron.js';
import type { UseElectron } from './use-electron.ability.js';

export class DiagnosticsArchive extends Ability {
  private readonly destination: string;
  private exportStarted = false;

  constructor(private readonly electron: UseElectron) {
    super();
    this.destination = join(electron.profileRoot, 'user-data', 'diagnostics-archive.zip');
  }

  async prepare(): Promise<void> {
    if (resolve(this.electron.profileRoot) !== resolve(licensedProfileRoot)) {
      throw new Error('Diagnostics export requires the dedicated licensed E2E profile');
    }
    if (this.exportStarted) throw new Error('The previous diagnostics export has not been discarded');
    const existing = await this.metadata();
    if (existing) throw new Error('An older diagnostics export exists; do not read or overwrite it');
    // Fixed by the product E2E save contract; inspect only this newly created export, never profile contents.
    this.exportStarted = true;
  }

  async savedBytes(): Promise<number> {
    const saved = await this.metadata();
    if (!this.exportStarted || !saved?.isFile() || saved.isSymbolicLink() || saved.size === 0) {
      throw new Error('The current diagnostics export did not create a regular non-empty local archive');
    }
    return saved.size;
  }

  async discard(): Promise<void> {
    if (!this.exportStarted) return;
    const saved = await this.metadata();
    if (saved) {
      if (!saved.isFile() || saved.isSymbolicLink()) throw new Error('Refusing to remove an unexpected diagnostics export target');
      await unlink(this.destination);
    }
    this.exportStarted = false;
  }

  private async metadata() {
    try {
      return await lstat(this.destination);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
}
