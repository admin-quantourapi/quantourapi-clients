import { eq } from 'drizzle-orm'

import { customScenarios } from './clientSchema'
import { db } from './index'

const MARKET_SCENARIOS = [
  {
    id: 'none',
    name: 'None (Price Only)',
    description: 'Standard view showing price and signals.',
    curve: [],
  },
  {
    id: '2008_crash',
    name: '2008 Financial Crisis',
    description: 'Systemic banking crisis leading to severe liquidity crunch. Characterized by a slow bleed followed by a violent capitulation.',
    curve: [
      100,
      95,
      88,
      85,
      70,
      55,
      45,
      50,
      60,
      65,
      75,
      85,
    ],
  },
  {
    id: '2020_covid',
    name: '2020 COVID-19 Flash Crash',
    description: 'Exogenous shock causing a rapid, violent sell-off followed by a V-shaped recovery driven by massive stimulus.',
    curve: [
      100,
      102,
      65,
      75,
      90,
      105,
      115,
      120,
      130,
      140,
      150,
      155,
    ],
  },
  {
    id: '2000_dotcom',
    name: 'Dot-Com Bubble Burst',
    description: 'Speculative tech bubble collapse. Characterized by a prolonged bear market for high-multiple growth stocks.',
    curve: [
      100,
      90,
      75,
      80,
      65,
      50,
      45,
      40,
      35,
      30,
      25,
      20,
    ],
  },
]

export async function seedScenarios() {
  try {
    for (const sc of MARKET_SCENARIOS) {
      const existing = await db.select().from(customScenarios).where(eq(customScenarios.id, sc.id)).limit(1)
      if (existing.length > 0) {
        await db.update(customScenarios)
          .set({
            name: sc.name,
            description: sc.description,
            curve: JSON.stringify(sc.curve),
            createdAt: new Date(),
          })
          .where(eq(customScenarios.id, sc.id))
      } else {
        await db.insert(customScenarios).values({
          id: sc.id,
          name: sc.name,
          description: sc.description,
          curve: JSON.stringify(sc.curve),
          createdAt: new Date(),
        })
      }
    }
    console.log('Seeded scenarios to Client API database')
  } catch (err) {
    console.error('Error seeding scenarios:', err)
  }
}
if (import.meta.main) {
  seedScenarios()
}
