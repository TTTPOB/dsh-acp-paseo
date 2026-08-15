import { describe, expect, it } from 'vitest'
import { buildPermissionToolCall } from '../src/permission.ts'

describe('buildPermissionToolCall', () => {
  it('uses the approval reason as the Paseo-visible tool-call title', () => {
    expect(buildPermissionToolCall('call-1', 'escalate sandbox to workspace-write: write build output')).toEqual({
      toolCallId: 'call-1',
      title: 'escalate sandbox to workspace-write: write build output',
    })
  })

  it('omits the title when the approval request has no reason', () => {
    expect(buildPermissionToolCall('call-2', undefined)).toEqual({ toolCallId: 'call-2' })
  })
})
