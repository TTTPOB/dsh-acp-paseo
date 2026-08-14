import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_RESULT_CHARS,
  parseToolArguments,
  renderToolResultText,
  toolKindForName,
  toolTitleFor,
} from '../src/tools.ts'

describe('toolKindForName', () => {
  it('maps shells to execute', () => {
    expect(toolKindForName('bash')).toBe('execute')
    expect(toolKindForName('pwsh')).toBe('execute')
  })

  it('maps file tools', () => {
    expect(toolKindForName('read')).toBe('read')
    expect(toolKindForName('read_image')).toBe('read')
    expect(toolKindForName('write')).toBe('edit')
    expect(toolKindForName('edit')).toBe('edit')
    expect(toolKindForName('str_replace_editor')).toBe('edit')
  })

  it('maps search, web and delegation tools', () => {
    expect(toolKindForName('grep')).toBe('search')
    expect(toolKindForName('glob')).toBe('search')
    expect(toolKindForName('web_search')).toBe('fetch')
    expect(toolKindForName('web_fetch')).toBe('fetch')
    expect(toolKindForName('todo_write')).toBe('think')
  })

  it('omits the kind for subagent delegation so Paseo shows the title label', () => {
    expect(toolKindForName('subagent')).toBeUndefined()
    expect(toolKindForName('subagent_fork')).toBeUndefined()
  })

  it('falls back to other for unknown names', () => {
    expect(toolKindForName('ralph')).toBe('other')
    expect(toolKindForName('create_goal')).toBe('other')
    expect(toolKindForName('custom_tool')).toBe('other')
  })
})

describe('parseToolArguments', () => {
  it('parses JSON arguments', () => {
    expect(parseToolArguments('{"command":"ls"}')).toEqual({ command: 'ls' })
  })

  it('returns the raw string when JSON is unparseable', () => {
    expect(parseToolArguments('{broken')).toBe('{broken')
  })
})

describe('toolTitleFor', () => {
  it('uses the command for shells', () => {
    expect(toolTitleFor('bash', '{"command":"ls -la"}')).toBe('ls -la')
  })

  it('uses the path for file tools', () => {
    expect(toolTitleFor('read', '{"path":"/src/main.ts"}')).toBe('/src/main.ts')
    expect(toolTitleFor('write', '{"file_path":"/src/out.ts"}')).toBe('/src/out.ts')
  })

  it('labels subagent delegation as Subagent regardless of the prompt', () => {
    expect(toolTitleFor('subagent', JSON.stringify({ prompt: 'analyze this directory deeply' }))).toBe('Subagent')
    expect(toolTitleFor('subagent_fork', '{broken')).toBe('Subagent')
  })

  it('uses the query for web search', () => {
    expect(toolTitleFor('web_search', '{"query":"deepseek harness"}')).toBe('deepseek harness')
  })

  it('falls back to the tool name for unreadable arguments', () => {
    expect(toolTitleFor('bash', '{broken')).toBe('bash')
    expect(toolTitleFor('edit', '{}')).toBe('edit')
  })
})

describe('renderToolResultText', () => {
  const blocks = [
    { type: 'text', text: 'first line' },
    { type: 'reasoning', text: 'hidden reasoning' },
    { type: 'text', text: 'second line' },
  ]

  it('concatenates text blocks and drops reasoning', () => {
    expect(renderToolResultText(blocks)).toBe('first line\nsecond line')
  })

  it('returns empty for no text', () => {
    expect(renderToolResultText([])).toBe('')
    expect(renderToolResultText([{ type: 'reasoning', text: 'x' }])).toBe('')
  })

  it('caps at MAX_TOOL_RESULT_CHARS with a truncation marker', () => {
    const text = renderToolResultText([{ type: 'text', text: 'y'.repeat(MAX_TOOL_RESULT_CHARS + 500) }])
    expect(text.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
  })
})
