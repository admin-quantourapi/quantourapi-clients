import { z } from 'zod'

export const FcfDataPointSchema = z.object({
  date: z.string(),
  freeCashFlow: z.number(),
  operatingCashFlow: z.number().optional(),
  capitalExpenditure: z.number().optional(),
  fiscalYear: z.union([
    z.string(),
    z.number(),
  ]).optional(),
  period: z.string().optional(),
  shares: z.number(),
  marketCap: z.number(),
  fcfPerShare: z.number(),
  impliedPrice: z.number(),
  ratio: z.number(),
  depreciationAndAmortization: z.number().optional(),
  researchAndDevelopmentExpenses: z.number().optional(),
  revenue: z.number().optional(),
})

export type FcfDataPoint = z.infer<typeof FcfDataPointSchema>
