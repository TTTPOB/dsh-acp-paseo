import { describe, expect, it } from 'vitest'
import {
  acpPromptToText,
  extractSlashCommand,
  promptHasUnsupportedContent,
  slashCommandName,
  turnEndToStopReason,
} from '../src/codec.ts'

describe('turnEndToStopReason', () => {
  it('maps completed to end_turn', () => {
    expect(turnEndToStopReason({ kind: 'completed' })).toBe('end_turn')
  })

  it('maps max-tokens to max_tokens', () => {
    expect(turnEndToStopReason({ kind: 'max-tokens' })).toBe('max_tokens')
  })

  it('maps interrupted to cancelled', () => {
    expect(turnEndToStopReason({ kind: 'interrupted' })).toBe('cancelled')
  })

  it.each(['aborted', 'blocked', 'error'])('maps %s to ordinary quiescence', (kind) => {
    expect(turnEndToStopReason({ kind })).toBe('end_turn')
  })

  it('falls back to end_turn for unknown kinds', () => {
    expect(turnEndToStopReason({ kind: 'mystery' })).toBe('end_turn')
  })
})

describe('acpPromptToText', () => {
  it('concatenates text blocks verbatim', () => {
    expect(acpPromptToText([{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }])).toBe('hello world')
  })

  it('renders resource links as bracketed references', () => {
    const text = acpPromptToText([{ type: 'resource_link', name: 'file.ts', uri: 'file:///tmp/file.ts' }])
    expect(text).toContain('[resource_link name="file.ts" uri="file:///tmp/file.ts"]')
  })

  it('drops unknown block types', () => {
    expect(acpPromptToText([{ type: 'image' }, { type: 'text', text: 'kept' }])).toBe('kept')
  })
})

describe('promptHasUnsupportedContent', () => {
  it('accepts the baseline (text + resource_link)', () => {
    expect(promptHasUnsupportedContent([{ type: 'text', text: 'x' }, { type: 'resource_link' }])).toBe(false)
  })

  it.each(['image', 'audio', 'embedded_resource'])('rejects %s blocks', (type) => {
    expect(promptHasUnsupportedContent([{ type: 'text', text: 'x' }, { type }])).toBe(true)
  })
})

describe('extractSlashCommand', () => {
  it('extracts a bare command', () => {
    expect(extractSlashCommand([{ type: 'text', text: '/compact' }])).toBe('/compact')
  })

  it('extracts a command with arguments', () => {
    expect(extractSlashCommand([{ type: 'text', text: '/goal set the objective' }])).toBe('/goal set the objective')
  })

  it('trims surrounding whitespace before matching', () => {
    expect(extractSlashCommand([{ type: 'text', text: '  /plan off\n' }])).toBe('/plan off')
  })

  it('rejects multi-block prompts', () => {
    expect(extractSlashCommand([{ type: 'text', text: '/compact' }, { type: 'text', text: 'more' }])).toBeUndefined()
  })

  it('rejects prompts mixing text and resource links', () => {
    expect(extractSlashCommand([{ type: 'resource_link' }])).toBeUndefined()
  })

  it('rejects ordinary prose', () => {
    expect(extractSlashCommand([{ type: 'text', text: 'please fix /etc/hosts' }])).toBeUndefined()
  })

  it('rejects empty text', () => {
    expect(extractSlashCommand([{ type: 'text', text: '   ' }])).toBeUndefined()
  })

  it('rejects a slash in the middle of the text', () => {
    expect(extractSlashCommand([{ type: 'text', text: 'a /compact b' }])).toBeUndefined()
  })
})

describe('slashCommandName', () => {
  it('parses the command name', () => {
    expect(slashCommandName('/goal set objective')).toBe('goal')
    expect(slashCommandName('/compact')).toBe('compact')
    expect(slashCommandName('/foo-bar_2 arg')).toBe('foo-bar_2')
  })

  it('returns undefined for unparseable lines', () => {
    expect(slashCommandName('/')).toBeUndefined()
    expect(slashCommandName('/UPPER')).toBeUndefined()
    expect(slashCommandName('goal')).toBeUndefined()
  })
})
