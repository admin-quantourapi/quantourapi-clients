import { USER_CUSTOM_AST_TAG } from '@quantour/shared-algo/src/finance-algo/astSchema'
import {
  describe, expect, test, 
} from 'bun:test'

import { validateAndStampStrategyAst } from './strategyAstValidation'

describe('validateAndStampStrategyAst', () => {
  test('accepts a valid AST object and stamps the user-custom ownership tag', () => {
    const result = validateAndStampStrategyAst({
      strategyName: 'MY_DIP_BUYER',
      entryLogic: {
        or: [
          {
            name: 'Oversold Bounce',
            and: [
              { indicator: 'rsi', operator: '<', value: 35 },
            ], 
          },
        ],
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = JSON.parse(result.json) as { tags?: string[] }
      expect(parsed.tags).toContain(USER_CUSTOM_AST_TAG)
    }
  })

  test('accepts a valid AST passed as a JSON string', () => {
    const result = validateAndStampStrategyAst('{"strategyName":"S","entryLogic":{"and":[{"indicator":"macro.vix","operator":"<","value":25}]}}')
    expect(result.ok).toBe(true)
  })

  test('rejects malformed JSON strings with a clear error', () => {
    const result = validateAndStampStrategyAst('{"strategyName": broken')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('not valid JSON')
  })

  test('returns structured issue paths for an invalid operator', () => {
    // The exact failure an AI agent hits when it invents an operator.
    const result = validateAndStampStrategyAst({
      strategyName: 'BROKEN',
      entryLogic: {
        or: [
          { indicator: 'rsi', operator: '===', value: 30 },
        ],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const operatorIssue = result.issues.find(i => i.path.includes('operator'))
      expect(operatorIssue?.message).toContain('Invalid option')
    }
  })

  test('rejects an AST without entryLogic', () => {
    const result = validateAndStampStrategyAst({ strategyName: 'NoLogic' })
    expect(result.ok).toBe(false)
  })

  test('preserves unknown keys from the original payload (no Zod stripping)', () => {
    const result = validateAndStampStrategyAst({
      strategyName: 'FUTURE_PROOF',
      futureField: { nested: true },
      entryLogic: { and: [] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const parsed = JSON.parse(result.json) as { futureField?: unknown }
      expect(parsed.futureField).toEqual({ nested: true })
    }
  })
})
