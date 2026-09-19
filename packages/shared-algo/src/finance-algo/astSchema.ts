// Side-effect import: type-level conformance guards make schema-vs-interface
// drift a COMPILE error on every consumer's tsc run. Must stay a .ts module
// (not a test) because shared-algo's tsconfig excludes *.test.ts.
import './astSchema.conformance'

import { z } from 'zod'

import type { ASTNode } from './ast'

/**
 * Runtime Zod validation for CustomStrategyAST payloads.
 *
 * Purpose: AI agents (Cursor/Claude/...) generate strategy ASTs from the public
 * schema docs; this schema is the machine-checkable contract they iterate
 * against (POST /api/settings returns structured issue paths on failure).
 * It mirrors the TypeScript interfaces in ./ast — keep BOTH in sync; the
 * conformance module (astSchema.conformance.ts) turns drift into a compile
 * error. Unknown keys are tolerated at runtime; only declared fields are
 * validated.
 *
 * NOTE: schemas here are deliberately UNANNOTATED (no `: z.ZodType<X>`), so
 * their inferred output types stay real and the conformance Equal/EqualKeys
 * assertions are meaningful — an annotation would collapse z.output to the
 * interface and make every check a tautology. The single exception is
 * ASTNodeSchema (recursion requires an annotation to break the inference
 * cycle); its checks run against the unannotated AstNodeObjectSchema instead.
 */

/** Tag stamped on ASTs saved through the settings API. migrateStrategyAst()
 * NEVER overwrites a stored AST carrying this tag — it marks user/agent-owned
 * strategy configs as opposed to seeded canonical defaults. */
export const USER_CUSTOM_AST_TAG = 'user_custom'

export const OperatorSchema = z.enum([
  '>',
  '<',
  '>=',
  '<=',
  '==',
  '!=',
  'exists',
  'missing',
])

export const BranchRiskProfileSchema = z.enum([
  'MOMENTUM',
  'MEAN_REVERSION',
  'VALUE',
  'GROWTH',
])

const COMPARISON_OPERATORS: readonly string[] = [
  '>',
  '<',
  '>=',
  '<=',
  '==',
  '!=',
]

export const ConditionNodeSchema = z.object({
  indicator: z.string().min(1),
  operator: OperatorSchema,
  value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
  ]).optional(),
  target: z.string().min(1).optional(),
})

/**
 * Recursive AST node — self-discriminating between condition nodes (carry
 * `indicator`) and logic groups (carry `and`/`or`). A z.union would mask the
 * specific refinement errors (a failed condition falls through to the group
 * variant and surfaces as a generic union error), so discrimination happens
 * inside one superRefine to keep error paths precise for AI agents.
 *
 * Structure: ASTNodeSchema (annotated, breaks the self-reference inference
 * cycle) delegates to AstNodeObjectSchema (unannotated — the conformance
 * module asserts its INFERRED shape against the interface variants).
 */
export const ASTNodeSchema: z.ZodType<ASTNode> = z.lazy(() => AstNodeObjectSchema)

export const AstNodeObjectSchema = z.object({
  // Condition-node fields
  indicator: z.string().min(1).optional(),
  operator: OperatorSchema.optional(),
  value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
  ]).optional(),
  target: z.string().min(1).optional(),
  // Logic-group fields
  and: z.array(z.lazy(() => ASTNodeSchema)).optional(),
  or: z.array(z.lazy(() => ASTNodeSchema)).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  weight: z.number().positive().optional(),
  riskProfile: BranchRiskProfileSchema.optional(),
  timeframeHorizon: z.string().optional(),
  targetRiskMultiplier: z.number().positive().optional(),
  stopLossAtrMultiplier: z.number().positive().optional(),
}).superRefine((node, ctx) => {
  if (node.indicator !== undefined) {
    if (node.and !== undefined || node.or !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [
          'indicator',
        ],
        message: 'Node mixes condition fields (indicator/operator) with logic-group fields (and/or) — split them into separate nodes',
      })
      return
    }
    if (node.operator === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [
          'operator',
        ],
        message: 'Condition node requires an "operator"', 
      })
      return
    }
    if (COMPARISON_OPERATORS.includes(node.operator) && node.value === undefined && node.target === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [
          'value',
        ],
        message: `Comparison operator "${node.operator}" requires "value" (static comparison) or "target" (another indicator)`,
      })
    }
    return
  }
  if (node.and === undefined && node.or === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [
        'and',
      ],
      message: 'Logic group must contain an "and" and/or "or" array of conditions (or add "indicator"+"operator" for a comparison node)',
    })
  }
})

const RegimeAdjustmentSchema = z.object({
  stopMultiplier: z.number().positive().optional(),
  targetMultiplier: z.number().positive().optional(),
  gapExitPercent: z.number().optional(),
  gapExitAtr: z.number().optional(),
  panicHoldDays: z.number().int().min(0).optional(),
})

export const RiskManagementSchema = z.object({
  stopLossAtrMultiplier: z.number().positive().optional(),
  targetRiskMultiplier: z.number().positive().optional(),
  chandelierAtrMultiplier: z.number().positive().optional(),
  partialExitTriggerR: z.number().positive().optional(),
  partialExitPercent: z.number().min(0).max(100).optional(),
  breakEvenActivationR: z.number().positive().optional(),
  chandelierActivationR: z.number().positive().optional(),
  gapExitThresholdPercent: z.number().optional(),
  gapExitThresholdAtr: z.number().optional(),
  overrideRiskPerTrade: z.number().positive().optional(),
  maxDaysToEarnings: z.number().int().min(0).optional(),
  minHoldingDays: z.number().int().min(0).optional(),
  maxHoldingDays: z.number().int().min(0).optional(),
  enableStrategyHandoff: z.boolean().optional(),
  enableSignalStopRefresh: z.boolean().optional(),
  handoffMinProfitR: z.number().min(0).optional(),
  branchRiskMultiplier: z.record(z.string(), z.number().positive()).optional(),
  stopFillMode: z.enum([
    'wick',
    'close',
  ]).optional(),
  stopPlacement: z.enum([
    'formula',
    'sweep_zone',
  ]).optional(),
  regimeAdjustments: z.object({
    RISK_ON: RegimeAdjustmentSchema.optional(),
    RISK_OFF: RegimeAdjustmentSchema.optional(),
  }).optional(),
})

export const DynamicScoringRuleSchema = z.object({
  condition: ASTNodeSchema,
  boost: z.number(),
  reason: z.string().optional(),
  // Interface declares RISK_ON/RISK_OFF only; production ASTs also use
  // EARLY_RECOVERY — accept any regime key -> number mapping. The conformance
  // module documents this deliberate widening.
  regimeMultiplier: z.record(z.string(), z.number()).optional(),
})

export const CohortGroupRuleSchema = z.object({
  name: z.string().min(1),
  leaders: z.array(z.string().min(1)).min(1),
  members: z.array(z.string().min(1)).min(1),
  memberPolicy: z.enum([
    'FOLLOW',
    'REVERSE',
  ]),
  leaderPolicy: z.enum([
    'TRADE',
    'SIGNAL_ONLY',
  ]).optional(),
  slowdownThreshold: z.number().optional(),
  capitalFlip: z.enum([
    'NONE',
    'TRIM_LEADERS',
    'ROTATE_TO_MEMBERS',
    'ROTATE_TO_CASH',
  ]).optional(),
})

export const RotationRulesSchema = z.object({
  enabled: z.boolean().optional(),
  minCandidateScore: z.number().optional(),
  minScoreDiff: z.number().optional(),
  scoreGainMultiplier: z.number().positive().optional(),
  weights: z.object({
    w_rr: z.number().optional(),
    w_s: z.number().optional(),
    w_m: z.number().optional(),
    w_t: z.number().optional(),
  }).optional(),
  allowCashDeployment: z.boolean().optional(),
  maxPortfolioPositions: z.number().int().min(0).optional(),
  minHoldingDays: z.number().optional(),
  branchMinHoldingDays: z.record(z.string(), z.number()).optional(),
  branchMaxHoldingDays: z.record(z.string(), z.number()).optional(),
  rotationExemptBranches: z.array(z.string()).optional(),
  maxHoldingDays: z.number().optional(),
  rotationCooldownDays: z.number().optional(),
  protectWinnerProfitPercent: z.number().optional(),
  excludedSectors: z.array(z.string()).optional(),
  excludedIndustries: z.array(z.string()).optional(),
  onlyExcludeInRiskOff: z.boolean().optional(),
  rotationScoring: z.enum([
    'score',
    'efficiency',
    'ev',
  ]).optional(),
  sellNewsGate: z.enum([
    'off',
    'require_score',
    'require_score_hold_dip',
  ]).optional(),
})

export const UniverseRulesSchema = z.object({
  minMarketCap: z.number().optional(),
  maxMarketCap: z.number().optional(),
  minAvgVolume: z.number().optional(),
  allowedSectors: z.array(z.string()).optional(),
  excludedSectors: z.array(z.string()).optional(),
  allowedIndustries: z.array(z.string()).optional(),
  excludedTickers: z.array(z.string()).optional(),
  whitelistTickers: z.array(z.string()).optional(),
})

export const PositionSizingRulesSchema = z.object({
  minCapitalPerTrade: z.number().positive().optional(),
  maxCapitalPerTrade: z.number().positive().optional(),
  maxPortfolioAllocationPercent: z.number().min(0).max(100),
  /** Max capitalDeployed as a multiple of entry dollar-risk (structural cap/risk decoupler). */
  capitalRiskRatioCap: z.number().positive().optional(),
  overrideRiskPerTrade: z.number().positive().optional(),
  riskRewardRatio: z.number().positive().optional(),
})

export const CustomStrategyASTSchema = z.object({
  strategyName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  minScoreToEmit: z.number().optional(),
  signalAggressiveness: z.number().min(0).max(1).optional(),
  maxTotalSignals: z.number().int().min(0).optional(),
  entryGuards: z.object({
    maxSma20ExtensionAtr: z.number().positive().optional(),
  }).optional(),
  universe: UniverseRulesSchema.optional(),
  universeRules: UniverseRulesSchema.optional(),
  positionSizing: PositionSizingRulesSchema.optional(),
  entryLogic: ASTNodeSchema,
  exitLogic: ASTNodeSchema.optional(),
  enableDefensiveRotation: z.boolean().optional(),
  rotationProfile: z.enum([
    'CONSERVATIVE',
    'BALANCED',
    'AGGRESSIVE',
  ]).optional(),
  rotationRules: RotationRulesSchema.optional(),
  cohortGroups: z.array(CohortGroupRuleSchema).optional(),
  cohortFromMacros: z.boolean().optional(),
  aiRiskMode: z.enum([
    'DEFENSIVE',
    'BALANCED',
    'AGGRESSIVE',
  ]).optional(),
  riskManagement: RiskManagementSchema.optional(),
  dynamicScoring: z.array(DynamicScoringRuleSchema).optional(),
})

/** Returns a copy of the AST with the user-custom ownership tag added. */
export function stampUserCustomAst<T extends { tags?: string[] }>(ast: T): T {
  const tags = Array.isArray(ast.tags) ? [
    ...ast.tags,
  ] : []
  if (!tags.includes(USER_CUSTOM_AST_TAG)) tags.push(USER_CUSTOM_AST_TAG)
  return { ...ast, tags }
}

/** Cheap raw-JSON check used by migrateStrategyAst to detect user-owned ASTs. */
export function hasUserCustomAstTag(rawJson: string): boolean {
  return rawJson.includes(`"${USER_CUSTOM_AST_TAG}"`)
}
