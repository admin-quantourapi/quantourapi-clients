/**
 * Universal Core Domain Primitives.
 * Only low-level, ubiquitous domain enums and union types used across the quant engine belong here.
 */
import { z } from 'zod'

export type MarketRegime = 'RISK_ON' | 'RISK_NEUTRAL' | 'RISK_OFF'
export const MarketRegimeSchema = z.enum([
  'RISK_ON',
  'RISK_NEUTRAL',
  'RISK_OFF',
])

export enum MacroNarrativesStatus {
  pending = 'PENDING',
  active = 'ACTIVE',
  reversing = 'REVERSING',
  inactive = 'INACTIVE',
  archived = 'ARCHIVED',
  capex_expansion = 'CAPEX_EXPANSION',
  supply_shortage = 'SUPPLY_SHORTAGE',
  commoditization = 'COMMODITIZATION',
  glut = 'GLUT',
}

export type MacroNarrativeStatus = `${MacroNarrativesStatus}`
/**
 * Zod schema companion to {@link MacroNarrativeStatus}. Use this to parse
 * varchar DB columns and external API payloads instead of `as MacroNarrativeStatus`
 * so corrupt rows surface as a ZodError (handled) instead of silently miscasting.
 */
export const MacroNarrativeStatusSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'REVERSING',
  'INACTIVE',
  'ARCHIVED',
  'CAPEX_EXPANSION',
  'SUPPLY_SHORTAGE',
  'COMMODITIZATION',
  'GLUT',
])

export enum GlobalEventsStatus {
  pending = 'PENDING',
  approved = 'APPROVED',
  dismissed = 'DISMISSED',
  finished = 'FINISHED',
}

export enum TickerCatalystsStatus {
  pending = 'PENDING',
  approved = 'APPROVED',
  dismissed = 'DISMISSED',
  rumor = 'RUMOR',
  imminent = 'IMMINENT',
  finished = 'FINISHED',
}

export enum PriceActionStatus {
  confirmed = 'CONFIRMED',
  unconfirmed = 'UNCONFIRMED',
  divergent = 'DIVERGENT',
  insider_accumulation_detected = 'INSIDER_ACCUMULATION_DETECTED',
}

export type ExposureType = 'BENEFICIARY' | 'VICTIM'
/**
 * Zod schema companion to {@link ExposureType}. Use this to parse varchar DB
 * columns and external payloads instead of `as ExposureType`.
 */
export const ExposureTypeSchema = z.enum([
  'BENEFICIARY',
  'VICTIM',
])

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
/**
 * Zod schema companion to {@link RiskSeverity}. Use this to parse varchar DB
 * columns and external payloads instead of `as RiskSeverity`.
 */
export const RiskSeveritySchema = z.enum([
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
])

export type MarketSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export const MarketSentimentSchema = z.enum([
  'BULLISH',
  'BEARISH',
  'NEUTRAL',
])

export type ImpactType = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
export const ImpactTypeSchema = z.enum([
  'POSITIVE',
  'NEGATIVE',
  'NEUTRAL',
])

export type RiskProfile = 'AGGRESSIVE' | 'BALANCED' | 'CONSERVATIVE'
export const RiskProfileSchema = z.enum([
  'AGGRESSIVE',
  'BALANCED',
  'CONSERVATIVE',
])

export type CatalystStatus = 'LAGGING' | 'PRICED_IN' | 'NEUTRAL'
export const CatalystStatusSchema = z.enum([
  'LAGGING',
  'PRICED_IN',
  'NEUTRAL',
])

export type FcfInflection = 'POSITIVE' | 'NONE' | 'NEGATIVE'
export const FcfInflectionSchema = z.enum([
  'POSITIVE',
  'NONE',
  'NEGATIVE',
])

export enum EvaluationDecision {
  approve = 'APPROVE',
  reject = 'REJECT',
}
export const EvaluationDecisionSchema = z.nativeEnum(EvaluationDecision)

export enum EvaluationType {
  narrative = 'NARRATIVE',
  global_event = 'GLOBAL_EVENT',
  ticker_catalyst = 'TICKER_CATALYST',
}
export const EvaluationTypeSchema = z.nativeEnum(EvaluationType)

export enum MacroExposureType {
  beneficiary = 'BENEFICIARY',
  atRisk = 'AT_RISK',
  none = 'NONE',
}
/** Zod schema companion to {@link MacroExposureType} (MarketData.stock.macro_exposure.type). */
export const MacroExposureTypeSchema = z.nativeEnum(MacroExposureType)

export enum GlobalLiquidityTrend {
  expanding = 'EXPANDING',
  shrinking = 'SHRINKING',
  neutral = 'NEUTRAL',
}
/** Zod schema companion to {@link GlobalLiquidityTrend} (MarketData.macro.global_liquidity.trend). */
export const GlobalLiquidityTrendSchema = z.nativeEnum(GlobalLiquidityTrend)

export enum LiquidityPhase {
  expansion = 'EXPANSION',
  contraction = 'CONTRACTION',
  neutral = 'NEUTRAL',
}
/** Zod schema companion to {@link LiquidityPhase} (MarketData.liquidityTrend, getFedLiquidityTrend().trend). */
export const LiquidityPhaseSchema = z.nativeEnum(LiquidityPhase)

export enum FedRateTrajectory {
  hiking = 'HIKING',
  paused = 'PAUSED',
  cutting = 'CUTTING',
}
/** Zod schema companion to {@link FedRateTrajectory} (MarketData.fedRateTrajectory, macro.fed_rate.trajectory). */
export const FedRateTrajectorySchema = z.nativeEnum(FedRateTrajectory)

export enum CohortRole {
  leader = 'LEADER',
  member = 'MEMBER',
}
/** Zod schema companion to {@link CohortRole} (MarketData.cohortRole). */
export const CohortRoleSchema = z.nativeEnum(CohortRole)

export enum RecentOutcomeType {
  global = 'GLOBAL',
  corporate = 'CORPORATE',
}
/** Zod schema companion to {@link RecentOutcomeType} (MarketData.recentOutcomes[].type). */
export const RecentOutcomeTypeSchema = z.nativeEnum(RecentOutcomeType)

