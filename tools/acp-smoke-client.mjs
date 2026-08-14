#!/usr/bin/env node
/**
 * End-to-end ACP smoke client for dsh-acp-paseo — mimics what Paseo does:
 * spawn the launcher, initialize, create a session, then exercise every
 * enhanced surface (catalog, modes, model switch, thought level, slash
 * commands) before one real prompt round-trip.
 *
 * Requires a working dsh install and a resolvable DEEPSEEK_API_KEY for the
 * prompt step; initialize/session-new pass without credentials.
 *
 * Usage:
 *   node tools/acp-smoke-client.mjs [--cwd <dir>] [--prompt <text>] [--timeout <ms>]
 *                                   [--direct] [--bin <dsh-bin>]
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'dsh-acp-paseo')
const LAUNCHER = join(PACKAGE_DIR, 'bin', 'dsh-acp-paseo-launch.mjs')

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    prompt: 'Reply with exactly: PONG',
    timeoutMs: 180_000,
    direct: false,
    bin: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--cwd':
        options.cwd = resolve(argv[++i])
        break
      case '--prompt':
        options.prompt = argv[++i]
        break
      case '--timeout':
        options.timeoutMs = Number(argv[++i])
        break
      case '--direct':
        options.direct = true
        break
      case '--bin':
        options.bin = argv[++i]
        break
      default:
        process.stderr.write(`unknown argument: ${argv[i]}\n`)
        process.exit(2)
    }
  }
  return options
}

async function loadSdk() {
  const candidates = [
    join(PACKAGE_DIR, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'),
    join(REPO_ROOT, 'node_modules', '@agentclientprotocol', 'sdk', 'package.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const require = createRequire(candidate)
    const resolved = require.resolve('@agentclientprotocol/sdk')
    return import(pathToFileURL(resolved).href)
  }
  process.stderr.write('ACP SDK not found — run `pnpm install` first\n')
  process.exit(1)
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms)),
  ])
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const sdk = await loadSdk()
  const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = sdk

  const command = options.direct
    ? ['dsh', '--profile', 'dsh-acp-paseo']
    : options.bin !== undefined
      ? ['node', options.bin]
      : [process.execPath, LAUNCHER]
  process.stderr.write(`[smoke] spawning: ${command.join(' ')}\n`)

  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stderrTail = []
  child.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim().length > 0) stderrTail.push(line)
      if (stderrTail.length > 25) stderrTail.shift()
    }
  })

  const chunks = []
  const commandsSeen = []
  const modeUpdates = []
  const thoughtChunks = []
  const toolCalls = new Map()
  let sessionResolved = false
  let commandBroadcastBeforeResponse = false
  const client = {
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    sessionUpdate: async (notification) => {
      const update = notification.update
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        chunks.push(update.content.text)
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
        thoughtChunks.push(update.content.text)
      } else if (update.sessionUpdate === 'available_commands_update') {
        // Paseo's ACPAgentSession drops updates whose sessionId does not yet
        // match its own (learned only from the session/new response). Any
        // broadcast before that response is lost there — fail on regression.
        if (!sessionResolved) commandBroadcastBeforeResponse = true
        commandsSeen.push(...update.availableCommands.map((command) => command.name))
      } else if (update.sessionUpdate === 'current_mode_update') {
        modeUpdates.push(update.currentModeId)
      } else if (update.sessionUpdate === 'tool_call') {
        toolCalls.set(update.toolCallId, {
          title: update.title,
          kind: update.kind ?? null,
          status: update.status ?? null,
        })
      } else if (update.sessionUpdate === 'tool_call_update') {
        const existing = toolCalls.get(update.toolCallId)
        toolCalls.set(update.toolCallId, { ...existing, status: update.status ?? existing?.status })
      }
    },
    readTextFile: async () => {
      throw new Error('not supported by smoke client')
    },
    writeTextFile: async () => {
      throw new Error('not supported by smoke client')
    },
    createTerminal: async () => {
      throw new Error('not supported by smoke client')
    },
  }

  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  )

  const fail = (message) => {
    process.stderr.write(`[smoke] FAIL: ${message}\n`)
    process.stderr.write(`[smoke] dsh stderr tail:\n${stderrTail.join('\n')}\n`)
    cleanup(1)
  }

  let exited = false
  const cleanup = (code) => {
    if (exited) return
    exited = true
    try {
      child.kill('SIGTERM')
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }, 5_000).unref()
    } catch {
      /* already gone */
    }
    setTimeout(() => process.exit(code), 500).unref()
  }

  try {
    const init = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'dsh-acp-paseo-smoke', version: '0.1.0' },
      }),
      60_000,
      'initialize',
    )
    if (init.protocolVersion !== PROTOCOL_VERSION) fail(`protocol version mismatch: ${init.protocolVersion}`)
    process.stderr.write(`[smoke] initialize ok (${init.agentInfo?.name} ${init.agentInfo?.version})\n`)

    const session = await withTimeout(
      connection.newSession({ cwd: options.cwd, mcpServers: [] }),
      60_000,
      'session/new',
    )
    const models = session.models
    if (models === undefined || models === null || !Array.isArray(models.availableModels) || models.availableModels.length === 0) {
      fail('session/new did not advertise a model catalog')
    }
    if (typeof models.currentModelId !== 'string' || models.currentModelId.length === 0) {
      fail('session/new did not advertise currentModelId')
    }
    const modeIds = (session.modes?.availableModes ?? []).map((mode) => mode.id)
    if (!modeIds.includes('execute') || !modeIds.includes('plan')) {
      fail(`session/new modes incomplete: ${JSON.stringify(modeIds)}`)
    }
    const thought = (session.configOptions ?? []).find((option) => option.category === 'thought_level')
    if (thought === undefined) fail('session/new did not advertise a thought_level config option')
    sessionResolved = true
    process.stderr.write(
      `[smoke] session/new ok — models: ${models.availableModels.map((model) => model.modelId).join(', ')}; ` +
        `current: ${models.currentModelId}; modes: ${modeIds.join(', ')}; thought: ${thought.currentValue}\n`,
    )

    await withTimeout(new Promise((resolve) => setTimeout(resolve, 1_500)), 5_000, 'commands window')
    if (commandBroadcastBeforeResponse) fail('available_commands_update arrived before session/new response — Paseo drops these')
    for (const expected of ['compact', 'plan', 'goal']) {
      if (!commandsSeen.includes(expected)) fail(`available_commands_update missing /${expected} (saw: ${commandsSeen.join(', ') || 'none'})`)
    }
    process.stderr.write(`[smoke] commands ok — ${commandsSeen.join(', ')}\n`)

    await withTimeout(connection.setSessionMode({ sessionId: session.sessionId, modeId: 'plan' }), 30_000, 'set_mode plan')
    await withTimeout(new Promise((resolve) => setTimeout(resolve, 500)), 5_000, 'mode broadcast')
    if (!modeUpdates.includes('plan')) process.stderr.write('[smoke] WARN: no current_mode_update after set_mode plan\n')
    await withTimeout(connection.setSessionMode({ sessionId: session.sessionId, modeId: 'execute' }), 30_000, 'set_mode execute')
    process.stderr.write('[smoke] mode switching ok\n')

    await withTimeout(
      connection.unstable_setSessionModel({ sessionId: session.sessionId, modelId: models.currentModelId }),
      30_000,
      'set_model',
    )
    process.stderr.write(`[smoke] model switching ok (${models.currentModelId})\n`)

    const configResponse = await withTimeout(
      connection.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'thought_level',
        value: 'high',
      }),
      30_000,
      'set_config_option',
    )
    const updated = (configResponse.configOptions ?? []).find((option) => option.category === 'thought_level')
    if (updated?.currentValue !== 'high') fail(`thought_level did not stick: ${JSON.stringify(updated)}`)
    process.stderr.write('[smoke] thought level ok (high)\n')

    const commandTurn = await withTimeout(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/compact' }],
      }),
      options.timeoutMs,
      'prompt /compact',
    )
    if (commandTurn.stopReason !== 'end_turn') fail(`/compact returned ${commandTurn.stopReason}`)
    process.stderr.write('[smoke] slash command ok (/compact → end_turn)\n')

    chunks.length = 0
    const turn = await withTimeout(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: options.prompt }],
      }),
      options.timeoutMs,
      'prompt',
    )
    const answer = chunks.join('')
    if (turn.stopReason === 'cancelled') fail('prompt was cancelled')
    if (answer.trim().length === 0) {
      process.stderr.write('[smoke] WARN: committed answer empty (missing DEEPSEEK_API_KEY?) — transport still passed\n')
    } else {
      process.stderr.write(`[smoke] answer: ${answer.slice(0, 120)}\n`)
    }
    if (thoughtChunks.length > 0) {
      process.stderr.write(`[smoke] reasoning streamed: ${thoughtChunks.length} thought chunk(s)\n`)
    } else {
      process.stderr.write('[smoke] WARN: no agent_thought_chunk received (model may not have reasoned)\n')
    }

    chunks.length = 0
    thoughtChunks.length = 0
    toolCalls.clear()
    const subagentTurn = await withTimeout(
      connection.prompt({
        sessionId: session.sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the subagent tool to analyze the current directory and report back its exact final answer. Do not run any other tools. Reply with the subagent answer verbatim.',
          },
        ],
      }),
      Math.max(options.timeoutMs, 300_000),
      'prompt subagent',
    )
    const subagentAnswer = chunks.join('')
    if (subagentTurn.stopReason === 'cancelled') fail('subagent prompt was cancelled')
    if (subagentTurn.stopReason !== 'end_turn') fail(`subagent prompt returned ${subagentTurn.stopReason}`)
    if (subagentAnswer.trim().length === 0) fail('subagent prompt produced no answer')
    process.stderr.write(`[smoke] subagent answer: ${subagentAnswer.slice(0, 200)}\n`)

    const tools = [...toolCalls.values()]
    if (tools.length === 0) {
      process.stderr.write('[smoke] WARN: no tool_call received for the subagent prompt\n')
    } else {
      const unclosed = tools.filter((entry) => entry.status !== 'completed' && entry.status !== 'failed')
      if (unclosed.length > 0) {
        fail(`tool calls never reached a terminal status: ${JSON.stringify(unclosed)}`)
      }
      const delegation = tools.find((entry) => entry.title === 'Subagent' || /^subagent/.test(entry.title ?? ''))
      if (delegation === undefined) {
        process.stderr.write(`[smoke] WARN: no subagent delegation tool seen (saw: ${tools.map((t) => `${t.title}:${t.status}`).join(', ') || 'none'})\n`)
      } else {
        if (delegation.kind !== null) {
          fail(`subagent delegation should omit the ACP kind (Paseo would label it '${delegation.kind}' instead of 'Subagent'): ${JSON.stringify(delegation)}`)
        }
        process.stderr.write(`[smoke] tool streaming ok — subagent delegation '${delegation.title}' ${delegation.status}\n`)
      }
    }

    await withTimeout(connection.cancel({ sessionId: session.sessionId }), 10_000, 'cancel')
    process.stderr.write('[smoke] PASS: full ACP round-trip succeeded\n')
    cleanup(0)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
