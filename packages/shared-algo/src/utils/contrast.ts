export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '')
  const num = parseInt(clean, 16)
  return [
    (num >> 16) & 255,
    (num >> 8) & 255,
    num & 255,
  ]
}

function srgbChannel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const [
    r,
    g,
    b,
  ] = hexToRgb(hex)
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

export function passesWCAGAA(hex1: string, hex2: string, large = false): boolean {
  return contrastRatio(hex1, hex2) >= (large ? 3 : 4.5)
}

export function contrastPair(fg: string, bg: string, large = false): { ratio: number; pass: boolean } {
  const ratio = contrastRatio(fg, bg)
  return { ratio, pass: passesWCAGAA(fg, bg, large) }
}
