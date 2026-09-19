import {
  describe, expect, test, 
} from 'bun:test'

import { generateSectorPieChart } from './chartService'

describe('chartService', () => {
  test('generateSectorPieChart returns null for empty exposure', async () => {
    const res = await generateSectorPieChart({})
    expect(res).toBeNull()
  })

  test('generateSectorPieChart calculates percentages correctly and formats datalabels', async () => {
    const exposure = {
      Technology: 5000,
      Healthcare: 3000,
      Cash: 2000,
    }
    const url = await generateSectorPieChart(exposure)
    expect(url).not.toBeNull()
    expect(url).toContain('https://quickchart.io/chart?c=')
    
    const urlObj = new URL(url!)
    const chartParam = urlObj.searchParams.get('c')
    expect(chartParam).not.toBeNull()
    
    const parsed = JSON.parse(chartParam!) as {
      data: { labels: unknown; datasets: { data: number[] }[] }
      options: { plugins: { datalabels: { color: string } } }
    }
    expect(parsed.data.labels).toEqual([
      'Technology',
      'Healthcare',
      'Cash',
    ])
    expect(parsed.data.datasets[0].data).toEqual([
      50,
      30,
      20,
    ]) // 50%, 30%, 20%
    expect(parsed.options.plugins.datalabels.color).toBe('#ffffff')
  })
})
