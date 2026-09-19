import { z } from 'zod'

// ==========================================
// TELEGRAM RAW TYPES (Subset)
// ==========================================

export interface TelegramChat {
  id: number
  type: string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramMessage {
  message_id: number
  from?: unknown
  chat: TelegramChat
  date: number
  text?: string
  entities?: unknown[]
  reply_to_message?: TelegramMessage
}

export interface TelegramCallbackQuery {
  id: string
  from: unknown
  message?: TelegramMessage
  inline_message_id?: string
  chat_instance: string
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  edited_channel_post?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

// ==========================================
// WEBSOCKET PROTOCOL TYPES
// ==========================================

/**
 * WebSocket protocol version shared by the bot gateway (server) and
 * client_api (client). Evolve the protocol ADDITIVELY ONLY: add new message
 * types / optional fields, never mutate or remove existing shapes — each
 * side runtime-parses the opposite direction's schema, so unknown types fail
 * loudly instead of corrupting silently. Bump this integer on ANY wire
 * change; both sides compile it in and the AUTH handshake enforces strict
 * equality (mismatched peers are rejected with an AUTH_RESULT error).
 */
export const WS_PROTOCOL_VERSION = 1

export enum WsMessageType {
  AUTH = 'auth',
  AUTH_RESULT = 'auth_result',
  TELEGRAM_UPDATE = 'telegram_update',
  SEND_MESSAGE = 'send_message',
  EDIT_MESSAGE = 'edit_message',
  DELETE_MESSAGE = 'delete_message',
  ANSWER_CALLBACK_QUERY = 'answer_callback_query',
  SEND_PHOTO = 'send_photo',
  SEND_DOCUMENT = 'send_document',
  SEND_CHAT_ACTION = 'send_chat_action',
  SET_MY_COMMANDS = 'set_my_commands',
  /** Application-level keepalive: client -> gateway. Gateway echoes PONG. */
  PING = 'ping',
  /** Keepalive echo: gateway -> client. */
  PONG = 'pong',
}

export const WsAuthMessageSchema = z.object({
  type: z.literal(WsMessageType.AUTH),
  chatId: z.string(), // The client_api connects and claims a chatId
  /**
   * Deliberately `z.number()`, not a literal pin: a client built against a
   * different protocol version must still PARSE on an older server so the
   * server can reply with a diagnosable AUTH_RESULT version mismatch
   * instead of a ZodError and a silent reconnect loop.
   */
  protocolVersion: z.number(),
})
export type WsAuthMessage = z.infer<typeof WsAuthMessageSchema>

/** Gateway ack/rejection for an incoming AUTH. Sent on BOTH success and failure. */
export const WsAuthResultMessageSchema = z.object({
  type: z.literal(WsMessageType.AUTH_RESULT),
  ok: z.boolean(),
  /** The gateway's WS_PROTOCOL_VERSION (lets a mismatched client log both sides). */
  protocolVersion: z.number(),
  reason: z.string().optional(),
})
export type WsAuthResultMessage = z.infer<typeof WsAuthResultMessageSchema>

export const WsTelegramUpdateMessageSchema = z.object({
  type: z.literal(WsMessageType.TELEGRAM_UPDATE),
  update: z.unknown(), // TelegramUpdate
})
export type WsTelegramUpdateMessage = z.infer<typeof WsTelegramUpdateMessageSchema>

export const WsSendMessageSchema = z.object({
  type: z.literal(WsMessageType.SEND_MESSAGE),
  chatId: z.string(),
  text: z.string(),
  parseMode: z.string().optional(),
  replyMarkup: z.unknown().optional(),
  replyToMessageId: z.number().optional(),
})
export type WsSendMessage = z.infer<typeof WsSendMessageSchema>

export const WsEditMessageSchema = z.object({
  type: z.literal(WsMessageType.EDIT_MESSAGE),
  chatId: z.string(),
  messageId: z.number(),
  text: z.string(),
  parseMode: z.string().optional(),
  replyMarkup: z.unknown().optional(),
})
export type WsEditMessage = z.infer<typeof WsEditMessageSchema>

export const WsDeleteMessageSchema = z.object({
  type: z.literal(WsMessageType.DELETE_MESSAGE),
  chatId: z.string(),
  messageId: z.number(),
})
export type WsDeleteMessage = z.infer<typeof WsDeleteMessageSchema>

export const WsAnswerCallbackQuerySchema = z.object({
  type: z.literal(WsMessageType.ANSWER_CALLBACK_QUERY),
  callbackQueryId: z.string(),
  text: z.string().optional(),
  showAlert: z.boolean().optional(),
})
export type WsAnswerCallbackQuery = z.infer<typeof WsAnswerCallbackQuerySchema>

export const WsSendPhotoSchema = z.object({
  type: z.literal(WsMessageType.SEND_PHOTO),
  chatId: z.string(),
  photo: z.string(),
  caption: z.string().optional(),
  parseMode: z.string().optional(),
  replyMarkup: z.unknown().optional(),
})
export type WsSendPhoto = z.infer<typeof WsSendPhotoSchema>

export const WsSendDocumentSchema = z.object({
  type: z.literal(WsMessageType.SEND_DOCUMENT),
  chatId: z.string(),
  document: z.string(),
  caption: z.string().optional(),
  parseMode: z.string().optional(),
})
export type WsSendDocument = z.infer<typeof WsSendDocumentSchema>

export const WsSendChatActionSchema = z.object({
  type: z.literal(WsMessageType.SEND_CHAT_ACTION),
  chatId: z.string(),
  action: z.string(),
})
export type WsSendChatAction = z.infer<typeof WsSendChatActionSchema>

export const WsSetMyCommandsSchema = z.object({
  type: z.literal(WsMessageType.SET_MY_COMMANDS),
  commands: z.array(z.object({
    command: z.string(),
    description: z.string(),
  })),
  languageCode: z.string().optional(),
})
export type WsSetMyCommands = z.infer<typeof WsSetMyCommandsSchema>

export const WsPingMessageSchema = z.object({
  type: z.literal(WsMessageType.PING),
})
export type WsPingMessage = z.infer<typeof WsPingMessageSchema>

export const WsPongMessageSchema = z.object({
  type: z.literal(WsMessageType.PONG),
})
export type WsPongMessage = z.infer<typeof WsPongMessageSchema>

export const WsClientMessageSchema = z.discriminatedUnion('type', [
  WsAuthMessageSchema,
  WsSendMessageSchema,
  WsEditMessageSchema,
  WsDeleteMessageSchema,
  WsAnswerCallbackQuerySchema,
  WsSendPhotoSchema,
  WsSendDocumentSchema,
  WsSendChatActionSchema,
  WsSetMyCommandsSchema,
  WsPingMessageSchema,
])
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  WsAuthResultMessageSchema,
  WsTelegramUpdateMessageSchema,
  WsPongMessageSchema,
])
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>
