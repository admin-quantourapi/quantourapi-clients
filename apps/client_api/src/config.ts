import { join } from 'path'
class ConfigService {
  private _isReady = false
  private _apiUrl!: string
  private _publicApiUrl!: string
  private _telegramBotToken!: string
  private _sqliteDbPath!: string
  private _botWsUrl!: string
  private _port!: string

  public init() {
    if (this._isReady) return
    this._apiUrl = this.requireEnv('API_URL', 'http://localhost:3001')
    this._publicApiUrl = this.requireEnv('PUBLIC_API_URL', 'http://localhost:3002')
    this._telegramBotToken = this.requireEnv('TELEGRAM_BOT_TOKEN', '')
    this._sqliteDbPath = this.requireEnv('SQLITE_DB_PATH', join(import.meta.dir, '../../local.db'))
    this._botWsUrl = this.requireEnv('BOT_WS_URL', 'ws://127.0.0.1:3004/ws')
    this._port = this.requireEnv('PORT', '3006')
    this._isReady = true
  }

  private requireEnv(name: string, defaultValue?: string): string {
    const value = process.env[name]
    if (!value) {
      if (defaultValue !== undefined) return defaultValue
      throw new Error(`Missing required environment variable: ${name}`)
    }
    return value
  }

  private ensureReady() {
    if (!this._isReady) {
      this.init()
    }
  }

  get API_URL() {
    this.ensureReady()
    return this._apiUrl
  }

  get PUBLIC_API_URL() {
    this.ensureReady()
    return this._publicApiUrl
  }

  get TELEGRAM_BOT_TOKEN() {
    this.ensureReady()
    return this._telegramBotToken
  }

  get SQLITE_DB_PATH() {
    this.ensureReady()
    return this._sqliteDbPath
  }

  get BOT_WS_URL() {
    this.ensureReady()
    return this._botWsUrl
  }

  get PORT() {
    this.ensureReady()
    return this._port
  }
}

export const config = new ConfigService()
