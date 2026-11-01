import { flattenPath, type Topology } from './path.ts'
import type { FontAsset } from './model.ts'

export interface TextLayout {
  topology: Topology
  coords(size: number): number[]
}

export function layoutText(font: FontAsset, text: string, align: 'left' | 'center' | 'right', letterSpacing: number, lineHeight: number): TextLayout {
  const glyphs = new Map(font.glyphs.map(g => [g.char, { advance: g.advance, ...flattenPath(g.path) }]))
  const kerning = new Map((font.kerning ?? []).map(([a, b, v]) => [`${a}\u0000${b}`, v]))
  const placed: { coords: number[]; fx: number; line: number; index: number }[] = []
  const lines = text.split('\n').map(l => Array.from(l))
  const widths: number[] = []
  const subpaths: Topology['subpaths'] = []
  lines.forEach((chars, line) => {
    let x = 0
    chars.forEach((ch, index) => {
      const g = glyphs.get(ch)
      if (g && g.coords.length) {
        placed.push({ coords: g.coords, fx: x, line, index })
        subpaths.push(...g.topology.subpaths)
      }
      x += (g?.advance ?? font.unitsPerEm / 2) + (kerning.get(`${ch}\u0000${chars[index + 1]}`) ?? 0)
    })
    widths.push(x)
  })
  return {
    topology: { subpaths },
    coords(size) {
      const s = size / font.unitsPerEm
      const out: number[] = []
      for (const p of placed) {
        const count = lines[p.line]!.length
        const width = widths[p.line]! * s + Math.max(0, count - 1) * letterSpacing
        const off = align === 'center' ? -width / 2 : align === 'right' ? -width : 0
        const ox = p.fx * s + p.index * letterSpacing + off
        const oy = p.line * lineHeight * size
        for (let i = 0; i < p.coords.length; i += 2) out.push(p.coords[i]! * s + ox, p.coords[i + 1]! * s + oy)
      }
      return out
    },
  }
}
