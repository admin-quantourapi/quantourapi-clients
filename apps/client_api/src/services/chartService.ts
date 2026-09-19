export const generateSectorPieChart = async (sectorExposure: Record<string, number>): Promise<string | null> => {
  const entries = Object.entries(sectorExposure)
  if (entries.length === 0) return null

  const total = entries.reduce((sum, [
    , val,
  ]) => sum + val, 0)
  if (total <= 0) return null

  const labels = entries.map(([
    label,
  ]) => label)
  // Convert values to percentages rounded to 1 decimal place (or whole integer if .0)
  const data = entries.map(([
    , val,
  ]) => {
    const pct = (val / total) * 100
    return Math.round(pct)
  })

  const chartConfig = {
    type: 'pie',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: [
            '#36A2EB',
            '#FF6384',
            '#FFCE56',
            '#4BC0C0',
            '#9966FF',
            '#FF9F40',
            '#2ECC71',
            '#E74C3C',
            '#F39C12',
            '#95A5A6',
            '#34495E',
          ],
        },
      ],
    },
    options: {
      plugins: {
        datalabels: {
          formatter: (value: number) => `${value}%`,
          color: '#ffffff',
          font: {
            weight: 'bold',
            size: 14,
          },
        },
      },
    },
  }

  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=500&h=300`
}
