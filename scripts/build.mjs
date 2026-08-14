#!/usr/bin/env node
/**
 * Build the dsh-acp-paseo bundle against PUBLISHED @deepseek-ai/* packages
 * (option A). All dependencies resolve from npm, so cordis exists exactly
 * once in the graph and the `declare module '@deepseek-ai/cordis'`
 * augmentations merge without any vendoring/symlink machinery.
 *
 * DSH_MONOREPO is a reserved extension point for a future snapshot-based
 * build (option B); v1 deliberately does not implement it.
 *
 * Usage: node scripts/build.mjs [--no-emit]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'dsh-acp-paseo')
const NO_EMIT = process.argv.includes('--no-emit')

if (process.env.DSH_MONOREPO !== undefined) {
  process.stderr.write(
    '[build] DSH_MONOREPO is reserved for a future snapshot-based build (option B) and is not implemented in v1.\n' +
      '[build] Unset DSH_MONOREPO to build against published @deepseek-ai/* packages.\n',
  )
  process.exit(2)
}

function resolveTypescript() {
  const candidates = [
    join(PACKAGE_DIR, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    join(REPO_ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  process.stderr.write('[build] typescript not found — run `pnpm install` first\n')
  process.exit(1)
}

function checkArtifacts() {
  const libDir = join(PACKAGE_DIR, 'lib')
  if (!existsSync(libDir)) {
    process.stderr.write('[build] lib/ missing after compile\n')
    process.exit(1)
  }
  const problems = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.js')) continue
      const source = readFileSync(full, 'utf8')
      if (/from\s+['"][^'"]*\.ts['"]/.test(source)) problems.push(full)
    }
  }
  walk(libDir)
  if (problems.length > 0) {
    process.stderr.write(`[build] emitted JS still imports .ts files:\n${problems.join('\n')}\n`)
    process.exit(1)
  }
}

const tsc = resolveTypescript()
const args = [tsc, '-p', join(PACKAGE_DIR, 'tsconfig.json')]
if (NO_EMIT) args.push('--noEmit', '--declarationDir', join(PACKAGE_DIR, 'node_modules', '.typecheck-types'))

process.stdout.write(`[build] ${NO_EMIT ? 'typecheck' : 'compile'} packages/dsh-acp-paseo\n`)
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: REPO_ROOT })
if (result.status !== 0) process.exit(result.status ?? 1)

if (!NO_EMIT) {
  checkArtifacts()
  const require = createRequire(pathToFileURL(join(REPO_ROOT, 'package.json')))
  const pkg = require(join(PACKAGE_DIR, 'package.json'))
  process.stdout.write(`[build] dsh-acp-paseo ${pkg.version} built to packages/dsh-acp-paseo/lib\n`)
}
