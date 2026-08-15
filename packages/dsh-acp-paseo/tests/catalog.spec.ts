import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_MODES,
  DEFAULT_COMMAND_BLOCKLIST,
  FALLBACK_EFFORTS,
  MODE_EXECUTE,
  MODE_PLAN,
  THOUGHT_LEVEL_CATEGORY,
  THOUGHT_LEVEL_CONFIG_ID,
  buildAvailableCommands,
  buildModeState,
  buildModelState,
  buildThoughtLevelOption,
  isEffortValue,
  isModeId,
  modeIdForPlanActive,
  resolveCatalogProvider,
  resolveEfforts,
} from '../src/catalog.ts'

const CATALOG = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: 'Flagship' },
]

describe('resolveCatalogProvider', () => {
  it('follows the dsh default route when the bridge is unpinned', () => {
    expect(resolveCatalogProvider(undefined, 'klaude-openai')).toBe('klaude-openai')
    expect(resolveCatalogProvider(undefined, 'opencode-go')).toBe('opencode-go')
  })

  it('keeps an explicit bridge route pin', () => {
    expect(resolveCatalogProvider('derived-provider', 'klaude-openai')).toBe('derived-provider')
  })
})

describe('buildModelState', () => {
  it('maps the dsh catalog to ACP model info', () => {
    const state = buildModelState(CATALOG, 'deepseek-v4-flash')
    expect(state.currentModelId).toBe('deepseek-v4-flash')
    expect(state.availableModels).toHaveLength(2)
    expect(state.availableModels[0]).toEqual({ modelId: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' })
    expect(state.availableModels[1]).toEqual({
      modelId: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Flagship',
    })
  })
})

describe('modes', () => {
  it('advertises exactly execute and plan', () => {
    expect(AVAILABLE_MODES.map((mode) => mode.id)).toEqual([MODE_EXECUTE, MODE_PLAN])
  })

  it('builds mode state with the current mode', () => {
    const state = buildModeState(MODE_EXECUTE)
    expect(state.currentModeId).toBe('execute')
    expect(state.availableModes).toEqual(AVAILABLE_MODES)
  })

  it('validates mode ids', () => {
    expect(isModeId('execute')).toBe(true)
    expect(isModeId('plan')).toBe(true)
    expect(isModeId('goal')).toBe(false)
    expect(isModeId('build')).toBe(false)
  })

  it('maps plan activity to mode ids', () => {
    expect(modeIdForPlanActive(true)).toBe(MODE_PLAN)
    expect(modeIdForPlanActive(false)).toBe(MODE_EXECUTE)
  })
})

describe('thought level', () => {
  it('falls back to off/high/max when the adapter advertises nothing', () => {
    expect(resolveEfforts(undefined)).toBe(FALLBACK_EFFORTS)
    expect(resolveEfforts([])).toBe(FALLBACK_EFFORTS)
  })

  it('prefers adapter-advertised efforts', () => {
    const efforts = [{ id: 'low', name: 'Low' }]
    expect(resolveEfforts(efforts)).toBe(efforts)
  })

  it('builds a select config option in the thought_level category', () => {
    const option = buildThoughtLevelOption('high', FALLBACK_EFFORTS)
    expect(option.type).toBe('select')
    expect(option.id).toBe(THOUGHT_LEVEL_CONFIG_ID)
    expect(option.category).toBe(THOUGHT_LEVEL_CATEGORY)
    expect(option.currentValue).toBe('high')
    expect(option.options.map((choice) => choice.value)).toEqual(['off', 'high', 'max'])
  })

  it('validates effort values against the session ladder', () => {
    expect(isEffortValue('max', FALLBACK_EFFORTS)).toBe(true)
    expect(isEffortValue('ultra', FALLBACK_EFFORTS)).toBe(false)
  })
})

describe('buildAvailableCommands', () => {
  const DESCRIPTORS = [
    { name: 'compact', description: 'Compact older conversation history' },
    { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
    { name: 'export', description: 'Download this Session log as a ZIP archive' },
  ]

  it('drops blocklisted commands', () => {
    const commands = buildAvailableCommands(DESCRIPTORS, DEFAULT_COMMAND_BLOCKLIST)
    expect(commands.map((command) => command.name)).toEqual(['compact', 'plan'])
  })

  it('carries the input hint when present', () => {
    const commands = buildAvailableCommands(DESCRIPTORS, [])
    expect(commands.find((command) => command.name === 'plan')?.input).toEqual({ hint: '[off|message]' })
    expect(commands.find((command) => command.name === 'compact')?.input).toBeUndefined()
  })
})
