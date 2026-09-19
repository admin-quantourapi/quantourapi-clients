import {
  describe, expect, test,
} from 'bun:test'

import { TRANSLATIONS } from './i18n'

describe('i18n key completeness', () => {
  test('every EN key has a UA translation', () => {
    const enKeys = Object.keys(TRANSLATIONS.en!)
    const uaKeys = new Set(Object.keys(TRANSLATIONS.ua!))
    const missing = enKeys.filter(k => !uaKeys.has(k))
    expect(missing).toEqual([])
  })

  test('every UA key has an EN translation', () => {
    const uaKeys = Object.keys(TRANSLATIONS.ua!)
    const enKeys = new Set(Object.keys(TRANSLATIONS.en!))
    const missing = uaKeys.filter(k => !enKeys.has(k))
    expect(missing).toEqual([])
  })

  test('no key has an empty string value in either language', () => {
    for (const [
      key,
      val,
    ] of Object.entries(TRANSLATIONS.en!)) {
      expect(val.length, `EN key "${key}" is empty`).toBeGreaterThan(0)
    }
    for (const [
      key,
      val,
    ] of Object.entries(TRANSLATIONS.ua!)) {
      expect(val.length, `UA key "${key}" is empty`).toBeGreaterThan(0)
    }
  })
})
