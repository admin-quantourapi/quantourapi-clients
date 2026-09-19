import { Database } from 'bun:sqlite'

/**
 * Cleanup B — drop the legacy budget columns that are no longer read or
 * written (the canonical store is user_budgets; free cash is computed live).
 *
 * Destructive one-off: run ONLY after the code that stops referencing these
 * columns is deployed (db/index.ts CREATE TABLE + missingSettingsColumns list
 * already exclude them, so the boot ALTER loop cannot re-add them).
 *
 * SQLite has no `DROP COLUMN IF EXISTS` — check PRAGMA table_info first.
 *
 *   bun run scripts/drop_legacy_budget_columns.ts
 */
const dbPath = process.env.SQLITE_DB_PATH || 'local.db'
const db = new Database(dbPath)

const DROPS: Array<{ table: string; column: string }> = [
  { table: 'settings', column: 'total_capital' },
  { table: 'settings', column: 'max_risk_per_trade' },
  { table: 'settings', column: 'available_cash' },
  { table: 'user_budgets', column: 'available_cash' },
]

const dropped: string[] = []
const alreadyGone: string[] = []

for (const { table, column } of DROPS) {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) {
    db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    dropped.push(`${table}.${column}`)
  } else {
    alreadyGone.push(`${table}.${column}`)
  }
}

console.log(`[MIGRATION] Dropped: ${dropped.length ? dropped.join(', ') : '(none)'}`)
console.log(`[MIGRATION] Already absent: ${alreadyGone.join(', ')}`)
db.close()
process.exit(0)
