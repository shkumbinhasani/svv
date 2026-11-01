import opentype from 'opentype.js'
import type { FontAsset, Glyph, Path, Subpath, Vec } from './model.ts'

function glyphPath(glyph: opentype.Glyph, upm: number): Path {
  const path: Path = []
  let cur: Subpath | null = null
  let pos: Vec = [0, 0]
  for (const c of glyph.getPath(0, 0, upm).commands) {
    if (c.type === 'M') {
      pos = [c.x, c.y]
      cur = { start: pos, segments: [], closed: false }
      path.push(cur)
    } else if (c.type === 'Z') {
      if (cur) cur.closed = true
      cur = null
    } else {
      if (!cur) {
        cur = { start: pos, segments: [], closed: false }
        path.push(cur)
      }
      const to: Vec = [c.x, c.y]
      if (c.type === 'L') cur.segments.push({ to })
      else if (c.type === 'C') cur.segments.push({ c1: [c.x1, c.y1], c2: [c.x2, c.y2], to })
      else if (c.type === 'Q') {
        const q: Vec = [c.x1, c.y1]
        cur.segments.push({ c1: [pos[0] + (2 / 3) * (q[0] - pos[0]), pos[1] + (2 / 3) * (q[1] - pos[1])], c2: [to[0] + (2 / 3) * (q[0] - to[0]), to[1] + (2 / 3) * (q[1] - to[1])], to })
      }
      pos = to
    }
  }
  return path
}

export function fontFromBytes(bytes: ArrayBuffer | Uint8Array, chars: string): FontAsset {
  const buffer = bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes
  const font = opentype.parse(buffer as ArrayBuffer)
  const upm = font.unitsPerEm
  const unique = [...new Set(Array.from(chars))].filter(c => c !== '\n')
  const glyphs: Glyph[] = unique.map(char => {
    const g = font.charToGlyph(char)
    return { char, advance: g.advanceWidth ?? upm / 2, path: glyphPath(g, upm) }
  })
  const kerning: [string, string, number][] = []
  for (const a of unique) {
    for (const b of unique) {
      const v = font.getKerningValue(font.charToGlyph(a), font.charToGlyph(b))
      if (v) kerning.push([a, b, v])
    }
  }
  const asset: FontAsset = { type: 'font', unitsPerEm: upm, ascent: font.ascender, descent: font.descender, glyphs }
  if (kerning.length) asset.kerning = kerning
  return asset
}
