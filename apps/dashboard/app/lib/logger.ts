type LogMeta = Record<string, unknown>

function emit(level: string, primary: LogMeta | string, msg?: string) {
  const meta: LogMeta = typeof primary === 'string' ? { msg: primary } : { ...primary, msg: msg ?? primary.msg }
  const label = `[${level.toUpperCase()}] ${meta.msg ?? ''}`
  if (level === 'error') {
    console.error(label, meta)
  } else {
    console.log(label, meta)
  }
}

export const logger = {
  debug: (primary: LogMeta | string, msg?: string) => emit('debug', primary, msg),
  info: (primary: LogMeta | string, msg?: string) => emit('info', primary, msg),
  warn: (primary: LogMeta | string, msg?: string) => emit('warn', primary, msg),
  error: (primary: LogMeta | string, msg?: string) => emit('error', primary, msg),
}
