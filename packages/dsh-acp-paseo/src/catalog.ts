/**
 * Pure derivation of the ACP session state surfaces Paseo auto-discovers:
 * model catalog, modes, thought-level config option, and the slash-command
 * list. Structural wire types keep this module dependency-free for tests.
 *
 * @module dsh-acp-paseo/catalog
 */

/** dsh llm catalog entry (structural mirror of LlmModelInfo). */
export interface DshModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** dsh provider descriptor (structural mirror of LlmProviderInfo). */
export interface DshProviderInfo {
  readonly id: string;
  readonly name: string;
}

/** One provider and the models it currently advertises. */
export interface DshProviderCatalog {
  readonly provider: DshProviderInfo;
  readonly models: readonly DshModelInfo[];
}

/** dsh command descriptor (structural mirror of CommandDescriptor). */
export interface DshCommandDescriptor {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
}

/** dsh reasoning effort metadata (structural mirror of LlmReasoningEffortInfo). */
export interface DshEffortInfo {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpModelInfo {
  readonly modelId: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModelState {
  availableModels: AcpModelInfo[];
  currentModelId: string;
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  availableModes: AcpSessionMode[];
  currentModeId: string;
}

export interface AcpSelectOption {
  readonly name: string;
  readonly value: string;
  readonly description?: string;
}

export interface AcpSelectConfigOption {
  type: 'select';
  id: string;
  name: string;
  category: string;
  currentValue: string;
  options: AcpSelectOption[];
  description?: string;
}

export interface AcpAvailableCommand {
  readonly name: string;
  readonly description: string;
  readonly input?: { readonly hint: string };
}

/** One decoded ACP model selection. */
export interface RoutedModelSelection {
  readonly provider: string;
  readonly model: string;
}

/** Encode one route/model pair into an unambiguous ACP model id. */
export function encodeModelId(provider: string, model: string): string {
  return `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
}

/** Decode an ACP model id emitted by {@link encodeModelId}. */
export function decodeModelId(modelId: string): RoutedModelSelection | undefined {
  const separator = modelId.indexOf('/');
  if (separator <= 0 || separator === modelId.length - 1) return undefined;
  try {
    const provider = decodeURIComponent(modelId.slice(0, separator));
    const model = decodeURIComponent(modelId.slice(separator + 1));
    return provider.length === 0 || model.length === 0 ? undefined : { provider, model };
  } catch {
    return undefined;
  }
}

/** Provider ids whose catalogs an ACP session exposes, default route first. */
export function catalogProviderIds(
  providers: readonly DshProviderInfo[],
  configuredProvider: string | undefined,
  defaultProvider: string,
): string[] {
  if (configuredProvider !== undefined) return [configuredProvider];
  const ids = providers.map((provider) => provider.id);
  return ids.includes(defaultProvider)
    ? [defaultProvider, ...ids.filter((provider) => provider !== defaultProvider)]
    : [defaultProvider, ...ids];
}

/**
 * Load provider catalogs in parallel, retaining successful non-empty siblings.
 * @param providers - selected provider descriptors in display order.
 * @param listModels - model loader for one provider route.
 * @param onFailure - observer for one provider-local failure.
 * @returns successful non-empty catalogs in provider order.
 */
export async function loadProviderCatalogs(
  providers: readonly DshProviderInfo[],
  listModels: (provider: string) => Promise<readonly DshModelInfo[]>,
  onFailure: (provider: string, error: unknown) => void,
): Promise<DshProviderCatalog[]> {
  const loaded = await Promise.all(providers.map(async (provider): Promise<DshProviderCatalog | undefined> => {
    try {
      const models = await listModels(provider.id);
      return models.length === 0 ? undefined : { provider, models };
    } catch (error) {
      onFailure(provider.id, error);
      return undefined;
    }
  }));
  return loaded.filter((catalog): catalog is DshProviderCatalog => catalog !== undefined);
}

/** Mode ids. `execute` is the default; `plan` mirrors dsh plan mode. */
export const MODE_EXECUTE = 'execute';
export const MODE_PLAN = 'plan';

export const AVAILABLE_MODES: readonly AcpSessionMode[] = [
  {
    id: MODE_EXECUTE,
    name: 'Execute',
    description: 'Normal coding: edits, tool execution, and implementation work',
  },
  {
    id: MODE_PLAN,
    name: 'Plan',
    description: 'Read-only planning; no file edits until the plan is approved',
  },
];

/** Config option identity for the thought-level selector. */
export const THOUGHT_LEVEL_CONFIG_ID = 'thought_level';
export const THOUGHT_LEVEL_CATEGORY = 'thought_level';

/** Fallback effort ladder when the adapter does not advertise one. */
export const FALLBACK_EFFORTS: readonly DshEffortInfo[] = [
  { id: 'off', name: 'Off', description: 'No extended reasoning' },
  { id: 'high', name: 'High', description: 'Extended reasoning' },
  { id: 'max', name: 'Max', description: 'Maximum reasoning budget' },
];

/** Commands that never make sense over a headless ACP transport. */
export const DEFAULT_COMMAND_BLOCKLIST: readonly string[] = ['export'];

export function isModeId(value: string): value is typeof MODE_EXECUTE | typeof MODE_PLAN {
  return value === MODE_EXECUTE || value === MODE_PLAN;
}

/** Map a dsh mode boolean (plan active?) to the ACP mode id. */
export function modeIdForPlanActive(active: boolean): string {
  return active ? MODE_PLAN : MODE_EXECUTE;
}

/** Resolve one ACP model id against the advertised provider catalogs. */
export function resolveCatalogModel(
  catalogs: readonly DshProviderCatalog[],
  modelId: string,
): RoutedModelSelection | undefined {
  const qualified = decodeModelId(modelId);
  if (qualified !== undefined) {
    return catalogs.some(({ provider, models }) => (
      provider.id === qualified.provider && models.some((model) => model.id === qualified.model)
    )) ? qualified : undefined;
  }
  const legacy = catalogs.flatMap(({ provider, models }) => (
    models.filter((model) => model.id === modelId).map((model) => ({ provider: provider.id, model: model.id }))
  ));
  return legacy.length === 1 ? legacy[0] : undefined;
}

/** Build the ACP model state from provider catalogs and the current selection. */
export function buildModelState(
  catalogs: readonly DshProviderCatalog[],
  current: RoutedModelSelection,
): AcpSessionModelState {
  return {
    availableModels: catalogs.flatMap(({ provider, models }) => models.map((model) => ({
      modelId: encodeModelId(provider.id, model.id),
      name: `${model.name} · ${provider.name}`,
      ...(model.description !== undefined ? { description: model.description } : {}),
    }))),
    currentModelId: encodeModelId(current.provider, current.model),
  };
}

/** Build the ACP mode state for a session. */
export function buildModeState(currentModeId: string): AcpSessionModeState {
  return { availableModes: [...AVAILABLE_MODES], currentModeId };
}

/**
 * Normalize the effort ladder: adapter-advertised efforts when present and
 * non-empty, otherwise the fallback off/high/max ladder.
 */
export function resolveEfforts(efforts: readonly DshEffortInfo[] | undefined): readonly DshEffortInfo[] {
  return efforts !== undefined && efforts.length > 0 ? efforts : FALLBACK_EFFORTS;
}

/** Build the thought_level select config option for the session state. */
export function buildThoughtLevelOption(
  currentValue: string,
  efforts: readonly DshEffortInfo[],
): AcpSelectConfigOption {
  return {
    type: 'select',
    id: THOUGHT_LEVEL_CONFIG_ID,
    name: 'Thinking',
    category: THOUGHT_LEVEL_CATEGORY,
    description: 'Reasoning effort for the selected model',
    currentValue,
    options: efforts.map((effort) => ({
      name: effort.name,
      value: effort.id,
      ...(effort.description !== undefined ? { description: effort.description } : {}),
    })),
  };
}

/** Whether a value is a legal effort id for the session's ladder. */
export function isEffortValue(value: string, efforts: readonly DshEffortInfo[]): boolean {
  return efforts.some((effort) => effort.id === value);
}

/** Config option identity for the permission-preset selector. */
export const PERMISSIONS_CONFIG_ID = 'permissions';
export const PERMISSIONS_CATEGORY = 'permissions';

/**
 * The derived not-a-preset state of dsh permission presets: shown as the
 * current value when the effective knobs match no table entry, never a
 * switch target.
 */
export const CUSTOM_PRESET_VALUE = 'custom';

/** Build the permissions select config option for the session state. */
export function buildPermissionOption(
  currentValue: string,
  options: readonly AcpSelectOption[],
): AcpSelectConfigOption {
  return {
    type: 'select',
    id: PERMISSIONS_CONFIG_ID,
    name: 'Permissions',
    category: PERMISSIONS_CATEGORY,
    description: 'Sandbox mode and approval policy preset',
    currentValue,
    options: [...options],
  };
}

/**
 * Whether a value is a legal permission switch target: an advertised preset
 * other than the derived-only {@link CUSTOM_PRESET_VALUE}.
 */
export function isPermissionValue(value: string, options: readonly AcpSelectOption[]): boolean {
  return options.some((option) => option.value === value && option.value !== CUSTOM_PRESET_VALUE);
}

/**
 * Map dsh command descriptors to ACP available commands, dropping blocklisted
 * names (web-only commands that cannot work over a headless transport).
 */
export function buildAvailableCommands(
  descriptors: readonly DshCommandDescriptor[],
  blocklist: readonly string[],
): AcpAvailableCommand[] {
  return descriptors
    .filter((descriptor) => !blocklist.includes(descriptor.name))
    .map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description,
      ...(descriptor.input !== undefined ? { input: { hint: descriptor.input.hint } } : {}),
    }));
}
