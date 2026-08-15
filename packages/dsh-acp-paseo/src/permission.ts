/** Pure ACP permission-request presentation helpers. */

/** Minimal ACP tool-call update carried by a permission request. */
export interface PermissionToolCall {
  readonly toolCallId: string
  readonly title?: string
}

/**
 * Attach the approval explanation to the ACP tool-call title Paseo displays.
 * @param toolCallId - Existing ACP tool call awaiting approval.
 * @param reason - Human-readable explanation supplied by the dsh approval asker.
 * @returns the permission request's tool-call update.
 */
export function buildPermissionToolCall(toolCallId: string, reason: string | undefined): PermissionToolCall {
  return {
    toolCallId,
    ...(reason === undefined ? {} : { title: reason }),
  }
}
