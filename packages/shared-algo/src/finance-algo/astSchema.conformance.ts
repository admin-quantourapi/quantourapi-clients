/**
 * TYPE-LEVEL CONFORMANCE GUARDS for the AST Zod schemas (astSchema.ts).
 *
 * Why this file exists: the CustomStrategyAST contract lives in TWO places —
 * the TypeScript interfaces (ast.ts, the engine's source of truth) and the
 * Zod schemas (astSchema.ts, the runtime validation agents iterate against).
 * Drift class we must catch: a field added to an interface but forgotten in
 * the schema (the ZodType<> annotations only enforce output→interface
 * assignability, which is blind to missing OPTIONAL fields).
 *
 * How it is enforced: astSchema.ts imports this file for its side effect, so
 * every `tsc` run over any consumer (apps/api, client_api, dashboard via the
 * @quantour/shared-algo path mappings — NOTE: shared-algo's own
 * tsconfig excludes *.test.ts, which is why these guards are a .ts module,
 * not a test) type-checks every assertion below. A drifted schema is a
 * COMPILE ERROR, not a test failure.
 *
 * Assertion strength is chosen per type:
 * - Exact `Equal<>` for enums and plain-object schemas whose fields are all
 *   optional scalars (zod v4 output of `.optional()` ≡ `field?: T` under the
 *   repo tsconfig, exactOptionalPropertyTypes off).
 * - `EqualKeys<>` (strict key-set equality) + bidirectional assignability
 *   where the interface is a union (ASTNode) or the schema widens a field by
 *   design (DynamicScoringRule.regimeMultiplier — production ASTs legitimately
 *   carry an EARLY_RECOVERY key the interface omits; see the inline note).
 */
import type { z } from 'zod'

import type {
  ASTNode, BranchRiskProfile, CohortGroupRule, ConditionNode, CustomStrategyAST, DynamicScoringRule, Operator, PositionSizingRules, RotationRules, UniverseRules,
} from './ast'
import type {
  AstNodeObjectSchema, BranchRiskProfileSchema, CohortGroupRuleSchema, ConditionNodeSchema, CustomStrategyASTSchema, DynamicScoringRuleSchema, OperatorSchema, PositionSizingRulesSchema, RiskManagementSchema, RotationRulesSchema, UniverseRulesSchema,
} from './astSchema'
import {
  type AstIndicatorPaths,INDICATOR_REGISTRY, 
} from './indicatorRegistry'

/** True iff X and Y are the identical type (not merely mutually assignable). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false

/** True iff every X is a Y (covariant check). */
type Assignable<X, Y> = X extends Y ? true : false

/** Strict set equality on unions (order-insensitive, no subset slop). */
type UnionEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/** True iff X and Y have exactly the same property keys (optional or not). */
type EqualKeys<X, Y> = UnionEq<keyof X & string, keyof Y & string>

type Assert<T extends true> = T

type LogicGroupNodeShape = Exclude<ASTNode, ConditionNode>

/** Union of every key appearing on ANY ASTNode variant. */
type AllNodeKeys = keyof ConditionNode | keyof LogicGroupNodeShape

type _AstSchemaConformanceChecks = [
  // --- Enums: exact ---
  Assert<Equal<z.output<typeof OperatorSchema>, Operator>>,
  Assert<Equal<z.output<typeof BranchRiskProfileSchema>, BranchRiskProfile>>,

  // --- ConditionNode: exact (plain object, optional scalar operands) ---
  Assert<Equal<z.output<typeof ConditionNodeSchema>, ConditionNode>>,
  Assert<EqualKeys<z.output<typeof ConditionNodeSchema>, ConditionNode>>,

  // --- ASTNode: interface is a union, schema is ONE self-discriminating
  // object (ASTNodeSchema is annotated only to break the recursion cycle, so
  // its z.output collapses to the interface — the REAL shape guard runs on
  // the unannotated AstNodeObjectSchema). Assert (a) the schema carries
  // exactly the union of all variant keys (catches a field added to either
  // ConditionNode or LogicGroupNode but not the schema), and (b) mutual
  // assignability in both directions.
  Assert<UnionEq<keyof z.output<typeof AstNodeObjectSchema> & string, AllNodeKeys>>,
  Assert<Assignable<z.output<typeof AstNodeObjectSchema>, ASTNode>>,
  Assert<Assignable<ASTNode, z.output<typeof AstNodeObjectSchema>>>,

  // --- Plain nested rules objects: exact key sets + exact types ---
  Assert<EqualKeys<z.output<typeof RotationRulesSchema>, RotationRules>>,
  Assert<Assignable<RotationRules, z.output<typeof RotationRulesSchema>>>,
  Assert<EqualKeys<z.output<typeof CohortGroupRuleSchema>, CohortGroupRule>>,
  Assert<Assignable<CohortGroupRule, z.output<typeof CohortGroupRuleSchema>>>,
  Assert<EqualKeys<z.output<typeof UniverseRulesSchema>, UniverseRules>>,
  Assert<Assignable<UniverseRules, z.output<typeof UniverseRulesSchema>>>,
  Assert<EqualKeys<z.output<typeof PositionSizingRulesSchema>, PositionSizingRules>>,
  Assert<Assignable<PositionSizingRules, z.output<typeof PositionSizingRulesSchema>>>,
  Assert<EqualKeys<z.output<typeof RiskManagementSchema>, NonNullable<CustomStrategyAST['riskManagement']>>>,
  Assert<Assignable<NonNullable<CustomStrategyAST['riskManagement']>, z.output<typeof RiskManagementSchema>>>,

  // --- DynamicScoringRule: regimeMultiplier is DELIBERATELY widened —
  // the interface declares only RISK_ON/RISK_OFF, but production ASTs
  // (AI_COMBINED dynamicScoring) legitimately use EARLY_RECOVERY, so the
  // schema accepts any regime-key -> number record. Everything else must
  // stay exactly in sync.
  Assert<EqualKeys<z.output<typeof DynamicScoringRuleSchema>, DynamicScoringRule>>,
  Assert<Assignable<DynamicScoringRule, z.output<typeof DynamicScoringRuleSchema>>>,
  Assert<Assignable<NonNullable<DynamicScoringRule['regimeMultiplier']>, NonNullable<z.output<typeof DynamicScoringRuleSchema>['regimeMultiplier']>>>,

  // --- Top-level CustomStrategyAST: strict key set both ways + mutual
  // assignability (entryLogic/exitLogic are ASTNode unions inside). ---
  Assert<EqualKeys<z.output<typeof CustomStrategyASTSchema>, CustomStrategyAST>>,
  Assert<Assignable<z.output<typeof CustomStrategyASTSchema>, CustomStrategyAST>>,
  Assert<Assignable<CustomStrategyAST, z.output<typeof CustomStrategyASTSchema>>>,

  // --- Indicator registry ⊆ reality: every documented AST indicator must be
  // a valid dot-path into MarketData (the evaluator's data context). Catches
  // documented indicators whose MarketData field was renamed/removed, and
  // registry entries with typos. The reverse is deliberately unchecked —
  // many MarketData fields are internal, not user-facing indicators. See
  // indicatorRegistry.ts. ---
  Assert<UnionEq<keyof typeof INDICATOR_REGISTRY, Extract<keyof typeof INDICATOR_REGISTRY, AstIndicatorPaths>>>,
]

