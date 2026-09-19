import {
  CustomStrategyASTSchema, stampUserCustomAst, 
} from '@quantour/shared-algo/src/finance-algo/astSchema'

/**
 * Pure validation + ownership-stamping for mainStrategyAst payloads submitted
 * to POST /api/settings. Kept side-effect-free so the semantics are
 * unit-testable (repo convention: pure function + thin route shell).
 *
 * On success the ORIGINAL object is serialized (not the Zod-parsed output) so
 * unknown/future keys survive byte-for-byte; only the USER_CUSTOM_AST_TAG is
 * added, which guarantees migrateStrategyAst() never overwrites the saved
 * strategy at boot.
 */
export type StrategyAstValidation =
  | { ok: true; json: string }
  | { ok: false; error: string; issues: { path: string; message: string }[] }

export function validateAndStampStrategyAst(input: unknown): StrategyAstValidation {
  let candidate: unknown = input
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return { ok: false, error: 'Invalid mainStrategyAst: not valid JSON', issues: [] }
    }
  }
  const result = CustomStrategyASTSchema.safeParse(candidate)
  if (!result.success) {
    return {
      ok: false,
      error: 'Invalid mainStrategyAst — see https://docs.quantourapi.com/ast-reference for the schema',
      issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
    }
  }
  return { ok: true, json: JSON.stringify(stampUserCustomAst(candidate as { tags?: string[] })) }
}
