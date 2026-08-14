/**
 * dsh-acp-paseo bridge: an enhanced ACP server mounted inside a dsh profile.
 *
 * On top of the baseline prompt/cancel transport this bridge exposes the
 * surfaces Paseo auto-discovers from `session/new`:
 *
 *   - the model catalog of the `deepseek-official` route (read live from
 *     `ctx.llm`) plus real model switching through `session/set_model`,
 *   - two session modes, `execute` and `plan`, mapped onto the dsh plan-mode
 *     boolean and switched through `session/set_mode`,
 *   - a `thought_level` config option (off/high/max) mapped onto the dsh
 *     `reasoningEffort`, switched through `session/set_config_option`,
 *   - the dsh slash-command registry, broadcast as
 *     `available_commands_update` and executed in-prompt (Command
 *     Passthrough), never sent to the model.
 *
 * Sessions stay fresh-only and connection-owned, mirroring the official
 * automation bridge's lifetime model.
 *
 * @module dsh-acp-paseo
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  AuthenticateRequest,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { Stream } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, errorChain, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-user-approval'
import '@deepseek-ai/dsh-plan-mode'
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-agent-default-model'
import {
  acpPromptToText,
  extractSlashCommand,
  promptHasUnsupportedContent,
  slashCommandName,
  turnEndToStopReason,
} from './codec.ts'
import {
  DEFAULT_CATALOG_PROVIDER,
  DEFAULT_COMMAND_BLOCKLIST,
  MODE_EXECUTE,
  MODE_PLAN,
  THOUGHT_LEVEL_CONFIG_ID,
  buildAvailableCommands,
  buildModeState,
  buildModelState,
  buildThoughtLevelOption,
  isEffortValue,
  isModeId,
  modeIdForPlanActive,
  resolveEfforts,
} from './catalog.ts'
import type { DshEffortInfo } from './catalog.ts'
import {
  parseToolArguments,
  renderToolResultText,
  toolKindForName,
  toolTitleFor,
} from './tools.ts'

export const name = 'dsh-acp-paseo'

/** The bridge creates and owns agents; every other concern is carried by the composition. */
export const inject = ['agents', 'llm', 'commands', 'planMode', 'agentDefaultModel']

const { version: BRIDGE_VERSION } = readPackageVersion()

function readPackageVersion(): { version: string } {
  try {
    return createRequire(import.meta.url)('../package.json') as { version: string }
  } catch {
    return { version: '0.0.0' }
  }
}

/** Structural view of the optional subagent drain service. */
interface ContinuableDrain {
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

export interface BridgeConfig {
  provider?: string
  model?: string
  commandBlocklist?: string[]
  /** Test-only transport override; never declared in the config schema. */
  stream?: Stream
}

export const Config = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  commandBlocklist: Schema.array(Schema.string()),
})

/** One in-flight prompt's correlation state. */
interface InflightSlot {
  resolve(reason: StopReason): void
  reject(error: Error): void
  messageId: string
  turn: number | undefined
  endReason: { kind: string } | undefined
}

interface SessionRecord {
  agent: Agent
  dispose(): Promise<void>
  inflight: InflightSlot | undefined
  selection: ModelSelectionRef
  disposeSelection(): void
  efforts: readonly DshEffortInfo[]
  commandAbort: AbortController | undefined
  inFlightTools: Set<string>
  broadcastTimers: ReturnType<typeof setTimeout>[]
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * Mount the Paseo-facing ACP bridge.
 * @param ctx - Cordis context of the dsh profile.
 * @param config - Optional provider/model pins, command blocklist, test transport.
 */
export function apply(ctx: Context, config: BridgeConfig): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const catalogProvider = config.provider ?? DEFAULT_CATALOG_PROVIDER
  const blocklist = config.commandBlocklist ?? [...DEFAULT_COMMAND_BLOCKLIST]
  const sessions = new Map<string, SessionRecord>()
  /** (sessionId:turn:step) pairs whose deltas were already streamed. */
  const streamedSteps = new Set<string>()
  let closed = false
  let conn: AgentSideConnection

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the ACP bridge has been disposed')
  }

  const requireSession = (sessionId: string): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification: SessionNotification): void => {
    conn.sessionUpdate(notification).catch((error) => {
      logger.warn(`acp: session/update failed: ${String(error)}`)
    })
  }

  const notifyText = (record: SessionRecord, text: string): void => {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
  }

  const notifyThought = (record: SessionRecord, text: string): void => {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
    })
  }

  const notifyMode = (record: SessionRecord, modeId: string): void => {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'current_mode_update', currentModeId: modeId },
    })
  }

  const notifyToolCall = (record: SessionRecord, callId: string, name: string, argumentsJson: string): void => {
    record.inFlightTools.add(callId)
    const kind = toolKindForName(name)
    notify({
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: toolTitleFor(name, argumentsJson),
        ...(kind !== undefined ? { kind } : {}),
        status: 'in_progress',
        rawInput: parseToolArguments(argumentsJson),
      },
    })
  }

  const notifyToolResult = (
    record: SessionRecord,
    callId: string,
    isError: boolean,
    text: string,
    errorDetail: string | undefined,
  ): void => {
    record.inFlightTools.delete(callId)
    notify({
      sessionId: record.agent.session.id,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        status: isError ? 'failed' : 'completed',
        ...(text.length > 0
          ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text } }] }
          : {}),
        rawOutput: isError
          ? { error: { message: errorDetail !== undefined && errorDetail.length > 0 ? errorDetail : 'tool call failed' } }
          : text.length > 0
            ? { output: text }
            : {},
      },
    })
  }

  /** Close every in-flight tool as failed (session cancel or connection teardown). */
  const failInFlightTools = (record: SessionRecord): void => {
    for (const callId of record.inFlightTools) {
      notify({
        sessionId: record.agent.session.id,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: callId,
          status: 'failed',
          rawOutput: { error: { message: 'cancelled' } },
        },
      })
    }
    record.inFlightTools.clear()
  }

  const listCommandsFor = (record: SessionRecord) => {
    try {
      return buildAvailableCommands(ctx.commands.list(record.agent), blocklist)
    } catch (error) {
      logger.warn(`acp: command listing failed: ${errorChain(error)}`)
      return []
    }
  }

  /** Push the session's command surface; called at creation and on registry changes. */
  const broadcastCommands = (record: SessionRecord): void => {
    notify({
      sessionId: record.agent.session.id,
      update: { sessionUpdate: 'available_commands_update', availableCommands: listCommandsFor(record) },
    })
  }

  /**
   * Command broadcasts must NOT be sent before the `session/new` response:
   * Paseo's ACPAgentSession drops any session/update whose sessionId does not
   * yet match its own (it learns the id only from the response), and its
   * message pump handles notifications concurrently with request responses.
   * The client also queries commands once right after session creation with
   * no wait (generic ACP `waitForInitialCommands` is false), so a single
   * post-response broadcast can still race that first query. Re-broadcast on
   * a small ladder after the response: the client's cache fills as soon as
   * one notification lands, and every later `list_commands` query hits it.
   */
  const COMMAND_BROADCAST_DELAYS_MS = [0, 250, 1000]

  const scheduleCommandBroadcast = (record: SessionRecord): void => {
    for (const delay of COMMAND_BROADCAST_DELAYS_MS) {
      record.broadcastTimers.push(
        setTimeout(() => {
          if (closed) return
          broadcastCommands(record)
        }, delay),
      )
    }
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  ctx.on('session/event', (session, event) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      if (event.type === 'assistant/chunk') {
        const chunk = event.data.chunk
        if (chunk.type === 'reasoning-delta') {
          streamedSteps.add(`${session.header.id}:${event.data.turn}:${event.data.step}`)
          notifyThought(record, chunk.text)
        } else if (chunk.type === 'text-delta') {
          streamedSteps.add(`${session.header.id}:${event.data.turn}:${event.data.step}`)
          notifyText(record, chunk.text)
        }
      } else if (event.type === 'assistant/message') {
        const key = `${session.header.id}:${event.data.turn}:${event.data.step}`
        const streamed = streamedSteps.has(key)
        streamedSteps.delete(key)
        for (const block of event.data.message.content) {
          if (block.type === 'text' && !streamed && block.text.length > 0) notifyText(record, block.text)
          else if (block.type === 'reasoning' && !streamed && block.text.length > 0) notifyThought(record, block.text)
          else if (block.type === 'image') {
            notifyText(record, `[image attachment ${block.attachment.attachmentId}]`)
          }
        }
      } else if (event.type === 'tool/call') {
        notifyToolCall(record, event.data.callId, event.data.name, event.data.arguments)
      } else if (event.type === 'tool/result') {
        const resultBlock = event.data.message.content[0]
        const isError = resultBlock?.isError === true
        const text = renderToolResultText(resultBlock?.content ?? [])
        const errorDetail =
          event.data.error !== undefined ? `${event.data.error.name}: ${event.data.error.code}` : undefined
        if (resultBlock?.toolCallId !== undefined) {
          notifyToolResult(record, resultBlock.toolCallId, isError, text, errorDetail)
        }
      } else if (event.type === 'plan/mode') {
        notifyMode(record, modeIdForPlanActive(event.data.active))
      }
    } finally {
      const inflight = record.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          record.inflight = undefined
          inflight.reject(internalError(`turn failed: ${event.data.reason.error.message}`))
        } else inflight.endReason = event.data.reason
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const inflight = ownedRecord(agent)?.inflight
    if (inflight !== undefined && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight === undefined || inflight.turn === turn) return
    record.inflight = undefined
    inflight.reject(internalError(`turn failed: ${errorChain(error)}`))
  })

  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn
      .requestPermission({
        sessionId: record.agent.session.id,
        toolCall: { toolCallId: request.callId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      })
      .then(({ outcome }) => {
        if (outcome.outcome === 'cancelled') return 'cancelled'
        return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
      })
  })

  ctx.on('commands/change', () => {
    for (const record of sessions.values()) broadcastCommands(record)
  })

  /**
   * Execute one slash command line through the dsh registry. Unknown names
   * fail the prompt with an RPC error (dsh `unknown-command` semantics); a
   * known command's error result is rendered as agent text instead, and a
   * command that starts a turn (e.g. `/plan <message>`) keeps the ACP turn
   * open until the agent is idle again.
   */
  const runSlashCommand = async (record: SessionRecord, line: string): Promise<StopReason> => {
    if (ctx.agents.get(record.agent.id) !== record.agent) {
      throw internalError('command was not executed: the agent was disposed outside the bridge')
    }
    const abort = new AbortController()
    record.commandAbort = abort
    try {
      const execution = await ctx.commands.execute(record.agent, line, abort.signal)
      if (execution === undefined) {
        throw invalidParams(`unknown command: /${slashCommandName(line) ?? line}`)
      }
      const text = execution.result.text
      if (text !== undefined && text.length > 0) notifyText(record, text)
      await record.agent.whenIdle()
      return abort.signal.aborted ? 'cancelled' : 'end_turn'
    } catch (error) {
      if (abort.signal.aborted) return 'cancelled'
      if (error instanceof RequestError) throw error
      throw internalError(`command failed: ${errorChain(error)}`)
    } finally {
      if (record.commandAbort === abort) record.commandAbort = undefined
    }
  }

  /** Resolve the session's effort ladder and default effort from the adapter. */
  const resolveSessionEfforts = async (
    model: string,
  ): Promise<{ efforts: readonly DshEffortInfo[]; defaultEffort: string | undefined }> => {
    try {
      const resolved = await ctx.llm.resolveModelInfo(catalogProvider, model)
      return {
        efforts: resolveEfforts(resolved.reasoning?.efforts),
        defaultEffort: resolved.reasoning?.defaultEffort,
      }
    } catch (error) {
      logger.warn(`acp: reasoning effort discovery failed: ${errorChain(error)}`)
      return { efforts: resolveEfforts(undefined), defaultEffort: undefined }
    }
  }

  const makeAgent = (connection: AgentSideConnection) => {
    conn = connection
    return {
      initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'dsh-acp-paseo', version: BRIDGE_VERSION },
          agentCapabilities: {
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        const defaultSelection = ctx.agentDefaultModel.currentSelection()
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: resolveAgentOptions(config, defaultSelection),
        })
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const agent = handle.agent

        let catalog: readonly LlmModelInfo[] = []
        try {
          catalog = await ctx.llm.listModels(catalogProvider)
        } catch (error) {
          logger.warn(`acp: model catalog discovery failed: ${errorChain(error)}`)
        }

        const currentModelId = pickCurrentModelId(config, catalogProvider, catalog, defaultSelection)
        const { efforts, defaultEffort } = await resolveSessionEfforts(currentModelId)

        const pinned = config.provider !== undefined || config.model !== undefined
        const selection: ModelSelectionRef = {
          current: {
            ...(pinned
              ? { provider: config.provider ?? catalogProvider, model: config.model ?? currentModelId }
              : { ...defaultSelection }),
            reasoningEffort: ReasoningEffortId(
              defaultSelection.reasoningEffort ?? defaultEffort ?? efforts[0]?.id ?? 'off',
            ),
          },
          assembled: undefined,
        }
        const disposeSelection = installModelSelection(agent.ctx, selection)

        const record: SessionRecord = {
          agent,
          dispose: () => handle.dispose(),
          inflight: undefined,
          selection,
          disposeSelection,
          efforts,
          commandAbort: undefined,
          inFlightTools: new Set<string>(),
          broadcastTimers: [],
        }
        sessions.set(sessionId, record)
        scheduleCommandBroadcast(record)

        const effort = selection.current?.reasoningEffort ?? 'off'
        return {
          sessionId,
          models: buildModelState(catalog, currentModelId),
          modes: buildModeState(MODE_EXECUTE),
          configOptions: [buildThoughtLevelOption(effort, efforts)],
        }
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        if (record.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
        if (promptHasUnsupportedContent(params.prompt)) {
          throw invalidParams('only text and resource_link prompt content is supported')
        }
        const text = acpPromptToText(params.prompt)
        if (text.trim().length === 0) throw invalidParams('empty prompt')

        const commandLine = extractSlashCommand(params.prompt)
        if (commandLine !== undefined) {
          return { stopReason: await runSlashCommand(record, commandLine) }
        }

        if (ctx.agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        return {
          stopReason: await new Promise<StopReason>((resolve, reject) => {
            const inflight: InflightSlot = {
              resolve,
              reject,
              messageId: message.id,
              turn: undefined,
              endReason: undefined,
            }
            record.inflight = inflight
            try {
              record.agent.followup(message)
            } catch (error) {
              record.inflight = undefined
              throw internalError(
                `prompt was not queued: ${error instanceof Error ? error.message : String(error)}`,
              )
            }
            record.agent.whenIdle().then(() => {
              if (record.inflight !== inflight) return
              record.inflight = undefined
              const end = inflight.endReason
              if (end === undefined) inflight.resolve('cancelled')
              else inflight.resolve(end.kind === 'max-tokens' ? 'end_turn' : turnEndToStopReason(end))
            })
          }),
        }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(params.sessionId)
        if (record === undefined) return Promise.resolve()
        record.commandAbort?.abort()
        failInFlightTools(record)
        record.agent.cancel({ kind: 'user' })
        settlePrompt(record, 'cancelled')
        return Promise.resolve()
      },

      setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        if (!isModeId(params.modeId)) throw invalidParams(`unknown mode: ${params.modeId}`)
        ctx.planMode.set(record.agent, params.modeId === MODE_PLAN)
        return Promise.resolve({})
      },

      async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        let catalog: readonly LlmModelInfo[] = []
        try {
          catalog = await ctx.llm.listModels(catalogProvider)
        } catch (error) {
          logger.warn(`acp: model catalog discovery failed: ${errorChain(error)}`)
        }
        if (!catalog.some((model) => model.id === params.modelId)) {
          throw invalidParams(
            `unknown model: ${params.modelId} (available: ${catalog.map((model) => model.id).join(', ')})`,
          )
        }
        const current = record.selection.current
        const next: ModelSelection = { provider: catalogProvider, model: params.modelId }
        if (current?.reasoningEffort !== undefined) next.reasoningEffort = current.reasoningEffort
        record.selection.current = next
        return {}
      },

      async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        const record = requireSession(params.sessionId)
        if (params.configId !== THOUGHT_LEVEL_CONFIG_ID) {
          throw invalidParams(`unknown config option: ${params.configId}`)
        }
        const value = params.value
        if (typeof value !== 'string' || !isEffortValue(value, record.efforts)) {
          throw invalidParams(`invalid value for ${THOUGHT_LEVEL_CONFIG_ID}: ${String(value)}`)
        }
        const current = record.selection.current
        if (current !== undefined) {
          record.selection.current = { ...current, reasoningEffort: ReasoningEffortId(value) }
        }
        return { configOptions: [buildThoughtLevelOption(value, record.efforts)] }
      },
    }
  }

  conn = new AgentSideConnection(
    makeAgent,
    config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  )

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const records = [...sessions.values()]
    sessions.clear()
    for (const record of records) {
      for (const timer of record.broadcastTimers) clearTimeout(timer)
      record.broadcastTimers = []
      record.commandAbort?.abort()
      failInFlightTools(record)
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    streamedSteps.clear()
    quiescing = (async () => {
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map((record) => record.agent))
        } catch (error) {
          logger.warn(`acp: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      for (const record of records) record.disposeSelection()
      const disposals = await Promise.allSettled(records.map((record) => record.dispose()))
      const failures: unknown[] = []
      for (const result of disposals) if (result.status === 'rejected') failures.push(result.reason)
      if (failures.length > 0) {
        const detail = failures.map((failure) => errorChain(failure)).join('; ')
        throw new AggregateError(failures, `ACP agent teardown failed for ${failures.length} session(s): ${detail}`)
      }
    })()
    return quiescing
  }

  conn.closed
    .catch((error) => {
      logger.warn(`acp: connection closed with an error: ${String(error)}`)
    })
    .then(quiesce)
    .catch((error) => {
      logger.warn(`acp: connection-close teardown failed: ${String(error)}`)
    })

  ctx.effect(() => quiesce, 'dsh-acp-paseo.connection')
}

/** Pick the model id displayed as current in the catalog Paseo receives. */
function pickCurrentModelId(
  config: BridgeConfig,
  catalogProvider: string,
  catalog: readonly LlmModelInfo[],
  defaultSelection: ModelSelection,
): string {
  if (config.model !== undefined) return config.model
  if (
    defaultSelection.provider === catalogProvider &&
    catalog.some((model) => model.id === defaultSelection.model)
  ) {
    return defaultSelection.model
  }
  return catalog[0]?.id ?? defaultSelection.model
}

/**
 * Build per-agent creation options. Config pins win; otherwise the deployment
 * default selection is used. Options are ALWAYS explicit: subagents inherit
 * `parent.options.provider/model` via `resolveChildAgentOptions`, and an
 * empty options object would leave the child's request route empty, failing
 * every child turn with "has no provider/model". (Web parity: the web host
 * passes the same explicit options on every session creation.)
 */
function resolveAgentOptions(config: BridgeConfig, defaultSelection: ModelSelection): { provider: string; model: string } {
  return {
    provider: config.provider ?? defaultSelection.provider,
    model: config.model ?? defaultSelection.model,
  }
}

/** Reject session features outside the bridge contract. */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  // Newer protocol revisions carry additionalDirectories; reject it defensively.
  const additional = (params as { additionalDirectories?: string[] }).additionalDirectories
  if (additional !== undefined && additional.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}
