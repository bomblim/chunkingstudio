export const TYPE_COLORS: Record<string, string> = {
  title: '#7c3aed',
  heading: '#6366f1',
  paragraph: '#0ea5e9',
  list: '#14b8a6',
  table: '#f59e0b',
  figure: '#ec4899',
  caption: '#d946ef',
  header: '#94a3b8',
  footer: '#94a3b8',
  footnote: '#a3a3a3',
  code: '#84cc16',
  formula: '#f97316',
  other: '#64748b',
}

const CHUNK_HUES = [212, 28, 140, 340, 262, 48, 180, 0, 100, 300]

export function chunkColor(index: number, alpha = 1) {
  const h = CHUNK_HUES[index % CHUNK_HUES.length]
  const l = 45 + (Math.floor(index / CHUNK_HUES.length) % 2) * 12
  return `hsl(${h} 70% ${l}% / ${alpha})`
}
