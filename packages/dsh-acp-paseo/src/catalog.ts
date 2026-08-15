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

/**
 * Resolve the provider route whose model catalog one ACP session exposes.
 * An explicit bridge pin wins; otherwise the session follows dsh's live
 * default selection instead of assuming a first-party route.
 */
export function resolveCatalogProvider(
  configuredProvider: string | undefined,
  defaultProvider: string,
): string {
  return configuredProvider ?? defaultProvider;
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

/** Build the ACP model state from the dsh catalog and the current selection. */
export function buildModelState(
  models: readonly DshModelInfo[],
  currentModelId: string,
): AcpSessionModelState {
  return {
    availableModels: models.map((model) => ({
      modelId: model.id,
      name: model.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
    })),
    currentModelId,
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
