#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyOpenClawBundlePatches } from './openclaw-bundle-patches.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OPENCLAW_DIR = path.join(REPO_ROOT, 'node_modules', 'openclaw');

applyOpenClawBundlePatches(OPENCLAW_DIR, { allowMissing: true });
