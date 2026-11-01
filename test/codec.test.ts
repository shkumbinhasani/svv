import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decode as decodeMovie, ellipse, encode, parseSvgPath, rect, star, toScene, writeMovie, type Path, type Scene } from '../src/index.ts'

const decode = (b: Uint8Array) => toScene(decodeMovie(b))
const reencode = (b: Uint8Array) => writeMovie(decodeMovie(b))

const scenesDir = join(import.meta.dir, '..', 'examples', 'scenes')

function maxPathError(a: Path, b: Path): number {
  let err = 0
  a.forEach((sp, i) => {
    const o = b[i]!
    const pts = (s: typeof sp) => [s.start, ...s.segments.flatMap(g => [g.c1, g.c2, g.to].filter(Boolean))] as [number, number][]
    const pa = pts(sp)
    const pb = pts(o)
    expect(pa.length).toBe(pb.length)
    pa.forEach((p, j) => (err = Math.max(err, Math.abs(p[0] - pb[j]![0]), Math.abs(p[1] - pb[j]![1]))))
  })
  return err
}

const kitchenSink: Scene = {
  width: 800,
  height: 600,
  duration: 3.5,
  loop: false,
  background: [10, 20, 30, 255],
  defs: [{ type: 'shape', path: ellipse(0, 0, 5), fill: { type: 'solid', color: [255, 0, 0, 128] } }],
  nodes: [
    {
      type: 'group',
      start: 0.5,
      end: 3,
      opacity: [{ t: 0, v: 0, ease: 'easeOut' }, { t: 1, v: 0.75 }],
      transform: { x: 100, y: [{ t: 0, v: 0, ease: [0.1, -0.5, 0.9, 1.5] }, { t: 2, v: 300, ease: 'hold' }, { t: 3, v: 10 }], rotation: 45, scaleX: 2, scaleY: 0.5, anchor: [10, 20] },
      children: [
        { type: 'use', ref: 0, transform: { x: [{ t: 0, v: 1, ease: 'smooth' }, { t: 1, v: 2, ease: 'smooth' }, { t: 2, v: 0 }] } },
        {
          type: 'shape',
          fillRule: 'evenodd',
          path: parseSvgPath('M10 10 h100 v100 h-100 z M30 30 l40 0 0 40 -40 0 z M200 200 q50 -80 100 0 t100 0 a40 60 30 1 1 -50 50'),
          fill: { type: 'linear', from: [0, 0], to: [100, 100], stops: [{ offset: 0, color: [1, 2, 3, 255] }, { offset: 0.5, color: [100, 200, 50, 255] }, { offset: 1, color: [0, 0, 0, 0] }] },
          stroke: { paint: { type: 'radial', center: [50, 50], radius: 80, stops: [{ offset: 0, color: [255, 255, 255, 255] }] }, width: [{ t: 0, v: 1 }, { t: 1, v: 6 }], join: 'bevel', cap: 'square' },
        },
        {
          type: 'shape',
          path: [{ t: 0, v: star(400, 300, 100, 40, 7), ease: 'easeInOut' }, { t: 1.5, v: rect(300, 200, 200, 200, 30) }, { t: 3, v: ellipse(400, 300, 90) }],
          fill: { type: 'solid', color: [{ t: 0, v: [255, 0, 0, 255] }, { t: 3, v: [0, 0, 255, 200] }] },
        },
      ],
    },
  ],
}

describe('codec', () => {
  test('rejects bad input', () => {
    expect(() => decode(new Uint8Array([1, 2, 3, 4]))).toThrow('not an SVV file')
    expect(() => decode(new Uint8Array([0x53, 0x56, 0x56, 9, 0]))).toThrow('unsupported')
  })

  test('round-trips every feature within quantization error', () => {
    const bytes = encode(kitchenSink, { chunkDuration: 10 })
    const out = decode(bytes)
    expect(out.width).toBe(800)
    expect(out.height).toBe(600)
    expect(out.duration).toBeCloseTo(3.5, 6)
    expect(out.loop).toBe(false)
    expect(out.background).toEqual([10, 20, 30, 255])
    expect(out.defs).toHaveLength(1)
    const wrapper = out.nodes[0]!
    if (wrapper.type !== 'group') throw new Error('expected chunk group')
    const g = wrapper.children[0]!
    if (g.type !== 'group') throw new Error('expected group')
    expect(g.start).toBeCloseTo(0.5, 6)
    expect(g.end).toBeCloseTo(3, 6)
    expect(g.transform?.anchor).toEqual([10, 20])
    expect(g.transform?.rotation).toBeCloseTo(45, 3)
    expect(g.transform?.scaleX).toBeCloseTo(2, 3)
    expect(g.transform?.scaleY).toBeCloseTo(0.5, 3)
    const y = g.transform?.y as { t: number; v: number; ease?: unknown }[]
    expect(y.map(k => k.ease)).toEqual([[0.1, -0.5, 0.9, 1.5].map(v => Math.round(v * 255) / 255), 'hold', undefined])
    const shape = g.children[1]!
    if (shape.type !== 'shape') throw new Error('expected shape')
    expect(shape.fillRule).toBe('evenodd')
    expect(shape.stroke?.join).toBe('bevel')
    expect(shape.stroke?.cap).toBe('square')
    const src = kitchenSink.nodes[0]!.type === 'group' ? (kitchenSink.nodes[0]!.children[1] as { path: Path }).path : []
    expect(maxPathError(src, shape.path as Path)).toBeLessThanOrEqual(2 ** -6)
  })

  test('re-encoding a decoded file is byte-identical', () => {
    for (const scene of [kitchenSink]) {
      const a = encode(scene)
      const b = reencode(a)
      expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true)
    }
  })

  test('precision is relative to canvas size', () => {
    const tiny: Scene = { width: 1, height: 1, duration: 1, nodes: [{ type: 'shape', path: ellipse(0.5, 0.5, 0.1234567) }] }
    const out = decode(encode(tiny))
    const wrapper = out.nodes[0]!
    if (wrapper.type !== 'group') throw new Error('expected chunk group')
    const p = wrapper.children[0]!
    if (p.type !== 'shape') throw new Error('expected shape')
    expect(maxPathError(ellipse(0.5, 0.5, 0.1234567), p.path as Path)).toBeLessThan(1e-4)
  })

  test('truncated files fail loudly', () => {
    const bytes = encode(kitchenSink)
    expect(() => decode(bytes.slice(0, Math.floor(bytes.length / 3)))).toThrow()
  })

  for (const file of readdirSync(scenesDir).filter(f => f.endsWith('.ts') && f !== 'util.ts')) {
    test(`example ${file} round-trips`, async () => {
      const scene: Scene = (await import(join(scenesDir, file))).default
      const a = encode(scene)
      const b = reencode(a)
      expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true)
    })
  }
})
