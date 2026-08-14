#!/usr/bin/env node
/**
 * Run the bundle's unit tests with the repo's own vitest (published-dep
 * baseline: no dsh snapshot required). Tests cover the pure codec/catalog
 * layer only; end-to-end behaviour is covered by tools/acp-smoke-client.mjs.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '..')

const candidates = [
  join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  join(REPO_ROOT, 'node_modules', '.bin', 'vitest'),
]
const vitest = candidates.find((candidate) => existsSync(candidate))
if (vitest === undefined) {
  process.stderr.write('[test] vitest not found — run `pnpm install` first\n')
  process.exit(1)
}

const args = vitest.endsWith('.mjs') ? [vitest, 'run'] : [vitest, 'run']
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: REPO_ROOT })
process.exit(result.status ?? 1)
