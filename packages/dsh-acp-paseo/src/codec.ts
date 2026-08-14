/**
 * Pure translation between the dsh session lifecycle and the ACP wire.
 * Everything here is dependency-free and unit-tested in isolation.
 *
 * @module dsh-acp-paseo/codec
 */

/** dsh turn-end reason kinds the bridge observes (structural mirror of TurnEndReason). */
export interface TurnEndReasonLike {
  readonly kind: string;
}

/** ACP prompt content block, structural mirror of the wire union. */
export interface PromptBlockLike {
  readonly type: string;
  readonly text?: string | null;
  readonly name?: string | null;
  readonly uri?: string | null;
}

/** ACP stop reasons the bridge ever emits. */
export type StopReason = 'end_turn' | 'max_tokens' | 'cancelled';

/**
 * Map a dsh turn ending to ACP's terminal reason vocabulary.
 * Hook/other-owner aborts and blocked/error endings are ordinary quiescence,
 * not prompt-level failures; `interrupted` is reserved for explicit client
 * cancellation and disposal.
 */
export function turnEndToStopReason(reason: TurnEndReasonLike): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn';
    case 'max-tokens':
      return 'max_tokens';
    case 'interrupted':
      return 'cancelled';
    case 'aborted':
    case 'blocked':
    case 'error':
    default:
      return 'end_turn';
  }
}

/**
 * Flatten ACP prompt blocks to text. Text blocks concatenate verbatim;
 * resource links become explicit bracketed references so the context is never
 * silently dropped.
 */
export function acpPromptToText(prompt: readonly PromptBlockLike[]): string {
  return prompt
    .flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text ?? ''];
        case 'resource_link':
          return [`\n[resource_link name=${JSON.stringify(block.name ?? '')} uri=${JSON.stringify(block.uri ?? '')}]\n`];
        default:
          return [];
      }
    })
    .join('');
}

/**
 * Whether a prompt carries content beyond the ACP baseline (text +
 * resource_link). Richer inline payloads are rejected, never silently dropped.
 */
export function promptHasUnsupportedContent(prompt: readonly PromptBlockLike[]): boolean {
  return prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link');
}

/**
 * Command Passthrough predicate: a prompt is a slash command exactly when it is
 * one single text block whose content starts with `/` (after trimming
 * surrounding whitespace). Any other shape — multiple blocks, resource links,
 * ordinary prose — is a normal model message even if it contains a `/` later.
 *
 * @returns the command line to hand to the dsh command registry, or undefined.
 */
export function extractSlashCommand(prompt: readonly PromptBlockLike[]): string | undefined {
  if (prompt.length !== 1) return undefined;
  const block = prompt[0];
  if (block === undefined || block.type !== 'text' || typeof block.text !== 'string') return undefined;
  const line = block.text.trim();
  if (!line.startsWith('/')) return undefined;
  return line;
}

/**
 * The command name of a slash line (`/goal set objective` → `goal`), for
 * diagnostics; undefined when the line has no parseable name.
 */
export function slashCommandName(line: string): string | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\s])/u.exec(line);
  return match?.[1];
}
