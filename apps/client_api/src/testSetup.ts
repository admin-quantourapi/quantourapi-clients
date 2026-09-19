import { config } from './config'

process.env.API_URL = process.env.API_URL || 'http://localhost:3001'
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || 'http://localhost:3002'
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-bot-token'
process.env.SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || ':memory:'

config.init()
