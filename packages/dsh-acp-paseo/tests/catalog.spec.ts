import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_MODES,
  CUSTOM_PRESET_VALUE,
  DEFAULT_COMMAND_BLOCKLIST,
  FALLBACK_EFFORTS,
  MODE_EXECUTE,
  MODE_PLAN,
  PERMISSIONS_CATEGORY,
  PERMISSIONS_CONFIG_ID,
  THOUGHT_LEVEL_CATEGORY,
  THOUGHT_LEVEL_CONFIG_ID,
  buildAvailableCommands,
  buildModeState,
  buildModelState,
  buildPermissionOption,
  buildThoughtLevelOption,
  catalogProviderIds,
  decodeModelId,
  encodeModelId,
  isEffortValue,
  isModeId,
  isPermissionValue,
  loadProviderCatalogs,
  modeIdForPlanActive,
  resolveCatalogModel,
  resolveEfforts,
} from '../src/catalog.ts'

const CATALOGS = [
  {
    provider: { id: 'klaude-openai', name: 'Klaude OpenAI Gateway' },
    models: [{ provider: 'klaude-openai', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
  },
  {
    provider: { id: 'opencode-go', name: 'opencode-go' },
    models: [
      { provider: 'opencode-go', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'opencode-go', id: 'shared/model', name: 'Shared Model', description: 'Qualified' },
    ],
  },
]

describe('ACP model ids', () => {
  it('round-trips provider and model ids without separator ambiguity', () => {
    const encoded = encodeModelId('derived/provider', 'shared/model')
    expect(encoded).toBe('derived%2Fprovider/shared%2Fmodel')
    expect(decodeModelId(encoded)).toEqual({ provider: 'derived/provider', model: 'shared/model' })
  })

  it('rejects malformed or incomplete ids', () => {
    expect(decodeModelId('unqualified')).toBeUndefined()
    expect(decodeModelId('provider/')).toBeUndefined()
    expect(decodeModelId('%ZZ/model')).toBeUndefined()
  })
})

describe('catalogProviderIds', () => {
  const providers = CATALOGS.map((catalog) => catalog.provider)

  it('includes every registered route with the default first', () => {
    expect(catalogProviderIds(providers, undefined, 'opencode-go')).toEqual(['opencode-go', 'klaude-openai'])
  })

  it('keeps an explicit bridge route as a single-provider pin', () => {
    expect(catalogProviderIds(providers, 'derived-provider', 'klaude-openai')).toEqual(['derived-provider'])
  })
})

describe('loadProviderCatalogs', () => {
  it('keeps successful providers when a sibling catalog fails', async () => {
    const failures: string[] = []
    const catalogs = await loadProviderCatalogs(
      CATALOGS.map((catalog) => catalog.provider),
      (provider) => provider === 'klaude-openai'
        ? Promise.resolve(CATALOGS[0].models)
        : Promise.reject(new Error('offline')),
      (provider) => failures.push(provider),
    )
    expect(catalogs).toEqual([CATALOGS[0]])
    expect(failures).toEqual(['opencode-go'])
  })

  it('drops empty catalogs without reporting failure', async () => {
    const failures: string[] = []
    const catalogs = await loadProviderCatalogs(
      CATALOGS.map((catalog) => catalog.provider),
      () => Promise.resolve([]),
      (provider) => failures.push(provider),
    )
    expect(catalogs).toEqual([])
    expect(failures).toEqual([])
  })
})

describe('resolveCatalogModel', () => {
  it('resolves a qualified model to its exact route', () => {
    expect(resolveCatalogModel(CATALOGS, 'opencode-go/deepseek-v4-flash')).toEqual({
      provider: 'opencode-go',
      model: 'deepseek-v4-flash',
    })
  })

  it('accepts an unqualified legacy id only when it is unique', () => {
    expect(resolveCatalogModel(CATALOGS, 'gpt-5.6-sol')).toEqual({
      provider: 'klaude-openai',
      model: 'gpt-5.6-sol',
    })
    const duplicate = [...CATALOGS, {
      provider: { id: 'another', name: 'Another' },
      models: [{ provider: 'another', id: 'gpt-5.6-sol', name: 'Duplicate' }],
    }]
    expect(resolveCatalogModel(duplicate, 'gpt-5.6-sol')).toBeUndefined()
  })
})

describe('buildModelState', () => {
  it('maps all provider catalogs to qualified ACP model info', () => {
    const state = buildModelState(CATALOGS, { provider: 'klaude-openai', model: 'gpt-5.6-sol' })
    expect(state.currentModelId).toBe('klaude-openai/gpt-5.6-sol')
    expect(state.availableModels).toHaveLength(3)
    expect(state.availableModels[0]).toEqual({
      modelId: 'klaude-openai/gpt-5.6-sol',
      name: 'GPT-5.6 Sol · Klaude OpenAI Gateway',
    })
    expect(state.availableModels[2]).toEqual({
      modelId: 'opencode-go/shared%2Fmodel',
      name: 'Shared Model · opencode-go',
      description: 'Qualified',
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

describe('permissions config option', () => {
  const PRESET_OPTIONS = [
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ]

  it('builds a select config option in the permissions category', () => {
    const option = buildPermissionOption('workspace-write', PRESET_OPTIONS)
    expect(option.type).toBe('select')
    expect(option.id).toBe(PERMISSIONS_CONFIG_ID)
    expect(option.category).toBe(PERMISSIONS_CATEGORY)
    expect(option.currentValue).toBe('workspace-write')
    expect(option.options).toEqual(PRESET_OPTIONS)
  })

  it('accepts the derived custom state as current value', () => {
    const option = buildPermissionOption(CUSTOM_PRESET_VALUE, [...PRESET_OPTIONS, {
      value: CUSTOM_PRESET_VALUE,
      name: 'Custom',
    }])
    expect(option.currentValue).toBe(CUSTOM_PRESET_VALUE)
  })

  it('validates switch targets but never the derived custom state', () => {
    const options = [...PRESET_OPTIONS, { value: CUSTOM_PRESET_VALUE, name: 'Custom' }]
    expect(isPermissionValue('workspace-write', options)).toBe(true)
    expect(isPermissionValue('danger-full-access', options)).toBe(true)
    expect(isPermissionValue(CUSTOM_PRESET_VALUE, options)).toBe(false)
    expect(isPermissionValue('read-only', options)).toBe(false)
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
