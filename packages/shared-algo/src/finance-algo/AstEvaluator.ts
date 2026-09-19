import {
  ASTNode, ConditionNode, LogicGroupNode, 
} from './ast'

function get(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  return path.split('.').reduce((acc: unknown, part: string) => {
    if (acc && typeof acc === 'object' && part in acc) {
      return (acc as Record<string, unknown>)[part]
    }
    return undefined
  }, obj)
}

/**
 * Float-aware equality for `==` / `!=` conditions. Relative epsilon so large
 * magnitudes (market caps, prices) don't get an absolute slack that grows
 * unboundedly, while near-equal computed indicators still match.
 */
function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1)
}

export interface AstEvaluationResult {
  isValid: boolean
  firedBranchName?: string
  firedBranchDescription?: string
  firedBranchTags?: string[]
  /**
   * Number of `or` branches that matched the data context. Always >= 1 when `isValid`
   * is true and the entry logic used an `or` group. Single-`and` setups report 1.
   * Used by screener.evaluateCustomStrategy for confluence scoring.
   */
  matchedBranchCount?: number
  /**
   * Names of all matched `or` branches (in declaration order). Empty for invalid setups
   * or single-`and` entry logic.
   */
  matchedBranchNames?: string[]
  /**
   * Sum of `weight` values of all matched branches (default weight = 1.0 per branch).
   * Lets future per-branch-weighted ASTs feed directly into the score without re-iteration.
   */
  matchedBranchWeight?: number
}

export class AstEvaluator {
  /**
   * Evaluates an AST Node against a given data context and returns details about fired branch(es).
   *
   * Confluence model (hybrid OR): when entry logic is an `or` group, EVERY branch is evaluated
   * (no short-circuit). All matching branches contribute their tags, names, and weights so
   * downstream scoring can reward multi-branch confluence. Validity still requires >= 1 match,
   * preserving backward compatibility with single-match setups.
   */
  static evaluateWithDetails(node: ASTNode, dataContext: Record<string, unknown>): AstEvaluationResult {
    if ('or' in node && node.or) {
      const branches = node.or as LogicGroupNode[]
      const matched: LogicGroupNode[] = []
      for (const child of branches) {
        if (this.evaluate(child, dataContext)) {
          matched.push(child)
        }
      }

      if (matched.length === 0) {
        return { isValid: false, matchedBranchCount: 0 }
      }

      // Aggregate tags from ALL matched branches (deduped, order-preserved)
      const tagSet = new Set<string>()
      for (const branch of matched) {
        for (const tag of branch.tags ?? []) {
          tagSet.add(tag)
        }
      }
      const matchedNames = matched
        .map((b) => b.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
      const matchedWeight = matched.reduce((sum, b) => sum + (b.weight ?? 1.0), 0)
      // Primary = the highest-weight matched branch (stable sort keeps declaration
      // order for ties). Downstream (riskProfile, stop/target multipliers,
      // expectedRPerDay stats) must reflect the dominant branch, not the first
      // match in declaration order.
      const ranked = [
        ...matched,
      ].sort((a, b) => (b.weight ?? 1.0) - (a.weight ?? 1.0))
      const primary = ranked[0]!

      return {
        isValid: true,
        firedBranchName: primary.name || 'Base Strategy Logic Met',
        firedBranchDescription: primary.description,
        firedBranchTags: tagSet.size > 0 ? Array.from(tagSet) : undefined,
        matchedBranchCount: matched.length,
        matchedBranchNames: matchedNames.length > 0 ? matchedNames : undefined,
        matchedBranchWeight: matchedWeight,
      }
    }

    const isValid = this.evaluate(node, dataContext)
    const topGroup = node as LogicGroupNode
    if (!isValid) {
      return { isValid: false, matchedBranchCount: 0 }
    }
    return {
      isValid,
      firedBranchName: topGroup.name || 'Base Strategy Logic Met',
      firedBranchDescription: topGroup.description,
      firedBranchTags: topGroup.tags,
      // Single `and` group: 1 branch equivalent for confluence accounting
      matchedBranchCount: 1,
      matchedBranchWeight: topGroup.weight ?? 1.0,
    }
  }

  /**
   * Evaluates an AST Node against a given data context.
   *
   * LogicGroupNode may carry `and`, `or`, or **both**. When both arrays are
   * non-empty (AI_COMBINED Branch 9 style: shared gates in `and` + velocity
   * alternatives in sibling `or`), the node is true iff
   *   every(`and`) AND some(`or`).
   * Previously `'and' in node` short-circuited and ignored sibling `or`, so
   * PMI/UMich velocity gates never ran.
   */
  static evaluate(node: ASTNode, dataContext: Record<string, unknown>): boolean {
    const group = node as LogicGroupNode
    const andKids = group.and
    const orKids = group.or
    const hasAnd = Array.isArray(andKids)
    const hasOr = Array.isArray(orKids)

    if (hasAnd || hasOr) {
      if ((hasAnd && andKids!.length === 0) || (hasOr && orKids!.length === 0)) {
        return false
      }
      const andOk = !hasAnd
        || andKids!.every((child) => this.evaluate(child, dataContext))
      const orOk = !hasOr
        || orKids!.some((child) => this.evaluate(child, dataContext))

      if (hasAnd && hasOr && andKids!.length > 0 && orKids!.length > 0) {
        return andOk && orOk
      }
      if (hasAnd) return andOk
      return orOk
    }

    const cond = node as ConditionNode
    const rawLeft = get(dataContext, cond.indicator)

    // Presence checks — must run before the null short-circuit below, since
    // exists/missing specifically test for null/undefined operands. They ignore
    // value/target and consider only whether the indicator is present.
    // Used by AI-named branches to pick a relaxed fallback (AI data present) vs
    // a tight, corroborated fallback (AI data absent) — see AI_COMBINED branches 4/6/8.
    if (cond.operator === 'exists') return rawLeft !== undefined && rawLeft !== null
    if (cond.operator === 'missing') return rawLeft === undefined || rawLeft === null

    const rawRight = cond.target ? get(dataContext, cond.target) : cond.value

    // If either operand is null or undefined:
    if (rawLeft === undefined || rawLeft === null || rawRight === undefined || rawRight === null) {
      if (cond.operator === '==') return rawLeft === rawRight
      if (cond.operator === '!=') return rawLeft !== rawRight
      return false
    }

    // Handle boolean comparisons
    if (typeof rawLeft === 'boolean' || typeof rawRight === 'boolean') {
      const leftBool = Boolean(rawLeft)
      const rightBool = Boolean(rawRight)
      if (cond.operator === '==') return leftBool === rightBool
      if (cond.operator === '!=') return leftBool !== rightBool
      return false
    }

    const leftNum = typeof rawLeft === 'number' ? rawLeft : parseFloat(String(rawLeft))
    const rightNum = typeof rawRight === 'number' ? rawRight : parseFloat(String(rawRight))

    const isNumeric = !isNaN(leftNum) && !isNaN(rightNum)

    if (isNumeric) {
      switch (cond.operator) {
        case '>':
          return leftNum > rightNum
        case '>=':
          return leftNum >= rightNum
        case '<':
          return leftNum < rightNum
        case '<=':
          return leftNum <= rightNum
        case '==':
          return approxEqual(leftNum, rightNum)
        case '!=':
          return !approxEqual(leftNum, rightNum)
        default:
          return false
      }
    }

    const leftStr = String(rawLeft)
    const rightStr = String(rawRight)

    switch (cond.operator) {
      case '==':
        return leftStr === rightStr
      case '!=':
        return leftStr !== rightStr
      case '>':
        return leftStr > rightStr
      case '>=':
        return leftStr >= rightStr
      case '<':
        return leftStr < rightStr
      case '<=':
        return leftStr <= rightStr
      default:
        return false
    }
  }
}
