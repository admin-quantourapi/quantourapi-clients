import { describe, expect, test } from 'bun:test'

import {
  WS_PROTOCOL_VERSION,
  WsAuthMessageSchema,
  WsAuthResultMessageSchema,
  WsClientMessageSchema,
  WsMessageType,
  WsServerMessageSchema,
} from './types'

describe('WS_PROTOCOL_VERSION', () => {
  test('is a positive integer (handshake strict-equality contract)', () => {
    expect(Number.isInteger(WS_PROTOCOL_VERSION)).toBe(true)
    expect(WS_PROTOCOL_VERSION).toBeGreaterThan(0)
  })
})

describe('WsAuthMessageSchema', () => {
  test('accepts a well-formed AUTH with the current protocol version', () => {
    const parsed = WsAuthMessageSchema.safeParse({
      type: WsMessageType.AUTH,
      chatId: '123456',
      protocolVersion: WS_PROTOCOL_VERSION,
    })
    expect(parsed.success).toBe(true)
  })

  test('still parses a FUTURE protocol version (server must be able to reject diagnosably)', () => {
    const parsed = WsAuthMessageSchema.safeParse({
      type: WsMessageType.AUTH,
      chatId: '123456',
      protocolVersion: WS_PROTOCOL_VERSION + 1,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.protocolVersion).toBe(WS_PROTOCOL_VERSION + 1)
  })

  test('rejects AUTH without protocolVersion (unversioned pre-handshake clients)', () => {
    const parsed = WsAuthMessageSchema.safeParse({
      type: WsMessageType.AUTH,
      chatId: '123456',
    })
    expect(parsed.success).toBe(false)
  })
})

describe('WsAuthResultMessageSchema', () => {
  test('parses a success ack', () => {
    const parsed = WsAuthResultMessageSchema.safeParse({
      type: WsMessageType.AUTH_RESULT,
      ok: true,
      protocolVersion: WS_PROTOCOL_VERSION,
    })
    expect(parsed.success).toBe(true)
  })

  test('parses a version-mismatch rejection with reason', () => {
    const parsed = WsAuthResultMessageSchema.safeParse({
      type: WsMessageType.AUTH_RESULT,
      ok: false,
      protocolVersion: WS_PROTOCOL_VERSION,
      reason: 'protocol version mismatch: server speaks 1, client sent 2',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.ok).toBe(false)
  })

  test('rejects AUTH_RESULT without ok / protocolVersion', () => {
    expect(
      WsAuthResultMessageSchema.safeParse({ type: WsMessageType.AUTH_RESULT }).success,
    ).toBe(false)
  })
})

describe('wire unions', () => {
  test('server union accepts AUTH_RESULT messages', () => {
    const parsed = WsServerMessageSchema.safeParse(
      JSON.stringify({ type: 'auth_result', ok: true, protocolVersion: 1 }),
    )
    // WsServerMessageSchema expects the parsed object, not a raw string
    expect(parsed.success).toBe(false)
    expect(
      WsServerMessageSchema.safeParse({ type: 'auth_result', ok: true, protocolVersion: 1 }).success,
    ).toBe(true)
  })

  test('client union rejects unknown message types (loud parse failure, not silent skip)', () => {
    const parsed = WsClientMessageSchema.safeParse({
      type: 'definitely_not_a_message',
      chatId: '123456',
      protocolVersion: 1,
    })
    expect(parsed.success).toBe(false)
  })
})
