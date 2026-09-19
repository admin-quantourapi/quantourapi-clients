/**
 * client_api logger: console output (existing behavior) PLUS an in-memory ring
 * buffer that a periodic BullMQ flush job drains into the persistent
 * `client_logs` SQLite table. warn/error survive container restarts and are
 * queryable via GET /api/client-logs (admin user-health page).
 *
 * The buffer is deliberately decoupled from the DB module (no circular import
 * at module load — the flush job imports the DB lazily).
 */
const MAX_BUFFER = 500

export interface BufferedLog {
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  chatId?: string
  meta?: unknown
  timestamp: Date
}

const buffer: BufferedLog[] = []

function push(level: BufferedLog['level'], args: unknown[]) {
  if (level !== 'warn' && level !== 'error') return
  const parts = args.map(a => (typeof a === 'string' ? a : safeStringify(a)))
  const first = args[0]
  const chatId = first && typeof first === 'object'
    ? (first as { chatId?: string }).chatId
    : undefined
  buffer.push({
    level,
    message: parts.join(' '),
    chatId,
    meta: first && typeof first === 'object' ? first : undefined,
    timestamp: new Date(),
  })
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function drainLogBuffer(): BufferedLog[] {
  return buffer.splice(0, buffer.length)
}

export const logger = {
  info: (...args: unknown[]) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args: unknown[]) => {
    console.warn(new Date().toISOString(), '[WARN]', ...args)
    push('warn', args)
  },
  error: (...args: unknown[]) => {
    console.error(new Date().toISOString(), '[ERROR]', ...args)
    push('error', args)
  },
  debug: (...args: unknown[]) => console.debug(new Date().toISOString(), '[DEBUG]', ...args),
}
