import {
  WsAnswerCallbackQuerySchema,
  WsDeleteMessageSchema,
  WsEditMessageSchema,
  WsMessageType,
  WsSendChatActionSchema,
  WsSendDocumentSchema,
  WsSendMessageSchema,
  WsSendPhotoSchema,
  WsSetMyCommandsSchema,
} from '@quantour/telegram'

import { logger } from './logger'
import { sendWsMessageToBot } from './telegramWsClient'

export interface TelegramMethodStrategy {
  execute: (body: Record<string, unknown>) => void
}

const sendMessageStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsSendMessageSchema.parse({
      type: WsMessageType.SEND_MESSAGE,
      chatId: String(body.chat_id ?? ''),
      text: String(body.text ?? ''),
      parseMode: body.parse_mode,
      replyMarkup: body.reply_markup,
      replyToMessageId: body.reply_to_message_id != null ? Number(body.reply_to_message_id) : undefined,
    })
    sendWsMessageToBot(parsed)
  },
}

const editMessageTextStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsEditMessageSchema.parse({
      type: WsMessageType.EDIT_MESSAGE,
      chatId: String(body.chat_id ?? ''),
      messageId: Number(body.message_id),
      text: String(body.text ?? ''),
      parseMode: body.parse_mode,
      replyMarkup: body.reply_markup,
    })
    sendWsMessageToBot(parsed)
  },
}

const deleteMessageStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsDeleteMessageSchema.parse({
      type: WsMessageType.DELETE_MESSAGE,
      chatId: String(body.chat_id ?? ''),
      messageId: Number(body.message_id),
    })
    sendWsMessageToBot(parsed)
  },
}

const answerCallbackQueryStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsAnswerCallbackQuerySchema.parse({
      type: WsMessageType.ANSWER_CALLBACK_QUERY,
      callbackQueryId: String(body.callback_query_id ?? ''),
      text: body.text,
      showAlert: body.show_alert,
    })
    sendWsMessageToBot(parsed)
  },
}

const sendPhotoStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsSendPhotoSchema.parse({
      type: WsMessageType.SEND_PHOTO,
      chatId: String(body.chat_id ?? ''),
      photo: body.photo,
      caption: body.caption,
      parseMode: body.parse_mode,
      replyMarkup: body.reply_markup,
    })
    sendWsMessageToBot(parsed)
  },
}

const sendDocumentStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsSendDocumentSchema.parse({
      type: WsMessageType.SEND_DOCUMENT,
      chatId: String(body.chat_id ?? ''),
      document: body.document,
      caption: body.caption,
      parseMode: body.parse_mode,
    })
    sendWsMessageToBot(parsed)
  },
}

const sendChatActionStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsSendChatActionSchema.parse({
      type: WsMessageType.SEND_CHAT_ACTION,
      chatId: String(body.chat_id ?? ''),
      action: body.action,
    })
    sendWsMessageToBot(parsed)
  },
}

const setMyCommandsStrategy: TelegramMethodStrategy = {
  execute: (body) => {
    const parsed = WsSetMyCommandsSchema.parse({
      type: WsMessageType.SET_MY_COMMANDS,
      commands: body.commands,
      languageCode: body.language_code,
    })
    sendWsMessageToBot(parsed)
  },
}

const telegramMethodStrategies: Record<string, TelegramMethodStrategy> = {
  sendMessage: sendMessageStrategy,
  editMessageText: editMessageTextStrategy,
  deleteMessage: deleteMessageStrategy,
  answerCallbackQuery: answerCallbackQueryStrategy,
  sendPhoto: sendPhotoStrategy,
  sendDocument: sendDocumentStrategy,
  sendChatAction: sendChatActionStrategy,
  setMyCommands: setMyCommandsStrategy,
}

export async function sendRawTelegram(method: string,
  body: Record<string, unknown>): Promise<{ ok: boolean; result?: { message_id?: number } }> {
  try {
    const strategy = telegramMethodStrategies[method]
    if (strategy) {
      strategy.execute(body)
      return { ok: true }
    } else {
      logger.warn({ method }, '[TELEGRAM] Method not supported via WebSocket proxy yet')
      return { ok: false }
    }
  } catch (e) {
    logger.error({ method, error: e }, '[TELEGRAM] WS Send Failed')
    return { ok: false }
  }
}
