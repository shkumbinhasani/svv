import type { Asset, Color, Keyframe, Path, Scene, SceneNode, Track, Vec } from '../model.ts'
import { loopsToPath, stackedShapes, type ContourOptions, type TracedShape } from './contour.ts'
import { probe, readFrames } from './frames.ts'
import { buildPalette, Quantizer, samplePixels, segment, type Rgb } from './segment.ts'
import { buildPlate, foregroundMask, type Plate } from './plate.ts'

export interface TraceOptions {
  width?: number
  height?: number
  fps?: number
  chunkDuration?: number
  colors?: number
  tolerance?: number
  minArea?: number
  minHole?: number
  cornerAngle?: number
  plate?: 'auto' | 'raster' | 'none'
  plateCrf?: number
  log?: (msg: string) => void
}

export interface TraceResult {
  scene: Scene
  fps: number
  width: number
  height: number
  frames: number
  palette: Rgb[]
  plate: boolean
  stats: { drawings: number; nodes: number; linked: number; created: number; keyframes: number }
}

interface MorphKey {
  t: number
  coords: number[]
  hold: boolean
}

interface NodeRec {
  color: number
  corners: boolean[][]
  counts: number[]
  keys: MorphKey[]
  last: TracedShape
  start: number
  end: number
}

const LINK_TOLERANCE = 1.25
const KEY_TOLERANCE = 0.3

function arc(points: Vec[]): number[] {
  const out = [0]
  for (let i = 1; i <= points.length; i++) out.push(out[i - 1]! + Math.hypot(points[i % points.length]![0] - points[i - 1]![0], points[i % points.length]![1] - points[i - 1]![1]))
  return out
}

export function follow(old: Vec[], dense: Vec[]): Vec[] | null {
  const k = old.length
  const m = dense.length
  if (m < 3) return null
  const centroid = (p: Vec[]): Vec => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const v of p) {
      x0 = Math.min(x0, v[0])
      y0 = Math.min(y0, v[1])
      x1 = Math.max(x1, v[0])
      y1 = Math.max(y1, v[1])
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2]
  }
  const co = centroid(old)
  const cd = centroid(dense)
  const tx = cd[0] - co[0]
  const ty = cd[1] - co[1]
  let n0 = 0
  let bd = Infinity
  dense.forEach((p, j) => {
    const d = (p[0] - old[0]![0] - tx) ** 2 + (p[1] - old[0]![1] - ty) ** 2
    if (d < bd) {
      bd = d
      n0 = j
    }
  })
  const D = [...dense.slice(n0), ...dense.slice(0, n0)]
  const lo = arc(old)
  const ld = arc(D)
  const To = lo[k]!
  const Td = ld[m]!
  if (To <= 0 || Td <= 0 || Td / To > 1.6 || To / Td > 1.6) return null
  const idx: number[] = [0]
  for (let i = 1; i < k; i++) {
    const want: Vec = [old[i]![0] + tx, old[i]![1] + ty]
    const step = ((lo[i]! - lo[i - 1]!) / To) * m
    const from = idx[i - 1]! + 1
    const to = Math.min(m - (k - i), from + Math.ceil(step * 2) + 4)
    if (from > to) return null
    let best = from
    let bestD = Infinity
    for (let q = from; q <= to; q++) {
      const d = (D[q]![0] - want[0]) ** 2 + (D[q]![1] - want[1]) ** 2
      if (d < bestD) {
        bestD = d
        best = q
      }
    }
    idx.push(best)
  }
  const out: Vec[] = idx.map(q => D[q]!)
  let seg = 0
  for (let q = 0; q < m; q++) {
    while (seg < k - 1 && idx[seg + 1]! <= q) seg++
    let best = Infinity
    for (const t of [seg - 1, seg, seg + 1]) {
      const a = out[(t + k) % k]!
      const b = out[(t + 1 + k) % k]!
      const dx = b[0] - a[0]
      const dy = b[1] - a[1]
      const len2 = dx * dx + dy * dy
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((D[q]![0] - a[0]) * dx + (D[q]![1] - a[1]) * dy) / len2)) : 0
      best = Math.min(best, Math.hypot(a[0] + dx * u - D[q]![0], a[1] + dy * u - D[q]![1]))
    }
    if (best > LINK_TOLERANCE) return null
  }
  return out
}

function bboxIou(a: TracedShape, b: TracedShape): number {
  const ix = Math.max(0, Math.min(a.x0 + a.w, b.x0 + b.w) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y0 + a.h, b.y0 + b.h) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

function lis(values: number[]): Set<number> {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(values.length).fill(-1)
  values.forEach((v, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid]! < v) lo = mid + 1
      else hi = mid
    }
    tails[lo] = v
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1]! : -1
  })
  const keep = new Set<number>()
  let k = tailIdx[tails.length - 1] ?? -1
  while (k >= 0) {
    keep.add(k)
    k = prev[k]!
  }
  return keep
}

class ChunkBuilder {
  order: NodeRec[] = []
  private active: NodeRec[] = []
  linked = 0
  created = 0

  constructor(private frameTime: number) {}

  private link(s: TracedShape, n: NodeRec): number[] | null {
    if (n.color !== s.color || n.counts.length !== s.loops.length) return null
    const coords: number[] = []
    let o = 0
    for (let j = 0; j < s.loops.length; j++) {
      const old: Vec[] = []
      const last = n.keys[n.keys.length - 1]!.coords
      for (let i = 0; i < n.counts[j]!; i++) old.push([last[o + 2 * i]!, last[o + 2 * i + 1]!])
      o += 2 * n.counts[j]!
      const pts = follow(old, s.loops[j]!.dense)
      if (!pts) return null
      for (const p of pts) coords.push(p[0], p[1])
    }
    return coords
  }

  drawing(shapes: TracedShape[], t: number) {
    const cands: { s: number; n: NodeRec; score: number }[] = []
    shapes.forEach((s, si) => {
      for (const n of this.active) {
        if (n.color !== s.color || n.counts.length !== s.loops.length) continue
        const r = s.area / n.last.area
        if (r < 0.6 || r > 1.6) continue
        const score = bboxIou(s, n.last)
        if (score > 0.25) cands.push({ s: si, n, score })
      }
    })
    cands.sort((a, b) => b.score - a.score)
    const matched: (NodeRec | null)[] = shapes.map(() => null)
    const coordsFor: (number[] | null)[] = shapes.map(() => null)
    const used = new Set<NodeRec>()
    for (const c of cands) {
      if (matched[c.s] || used.has(c.n)) continue
      const coords = this.link(shapes[c.s]!, c.n)
      if (!coords) continue
      matched[c.s] = c.n
      coordsFor[c.s] = coords
      used.add(c.n)
    }
    const pos = new Map(this.order.map((n, i) => [n, i]))
    const idx = matched.map((m, i) => (m ? i : -1)).filter(i => i >= 0)
    const keepLocal = lis(idx.map(i => pos.get(matched[i]!)!))
    const kept = new Set(idx.filter((_, j) => keepLocal.has(j)).map(i => matched[i]!))
    for (const n of this.active) if (!kept.has(n)) n.end = t
    const next: NodeRec[] = []
    let prevNode: NodeRec | null = null
    shapes.forEach((s, i) => {
      const m = matched[i]
      if (m && kept.has(m)) {
        const lastKey = m.keys[m.keys.length - 1]!
        lastKey.hold = t - lastKey.t > this.frameTime * 1.5
        m.keys.push({ t, coords: coordsFor[i]!, hold: false })
        m.last = s
        next.push(m)
        prevNode = m
        this.linked++
        return
      }
      const coords: number[] = []
      for (const l of s.loops) for (const p of l.points) coords.push(p[0], p[1])
      const node: NodeRec = { color: s.color, corners: s.loops.map(l => l.corners), counts: s.loops.map(l => l.points.length), keys: [{ t, coords, hold: false }], last: s, start: t, end: Infinity }
      const at = prevNode ? this.order.indexOf(prevNode) + 1 : 0
      this.order.splice(at, 0, node)
      next.push(node)
      prevNode = node
      this.created++
    })
    this.active = next
  }

  close(t: number) {
    for (const n of this.active) n.end = t
    this.active = []
  }
}

function reduceKeys(keys: MorphKey[]): MorphKey[] {
  if (keys.length <= 2) return keys
  const kept: MorphKey[] = [keys[0]!]
  for (let i = 1; i < keys.length - 1; i++) {
    const a = kept[kept.length - 1]!
    const k = keys[i]!
    const b = keys[i + 1]!
    let ok = true
    if (a.hold) {
      for (let c = 0; c < k.coords.length && ok; c++) if (Math.abs(a.coords[c]! - k.coords[c]!) > KEY_TOLERANCE) ok = false
    } else if (k.hold) ok = false
    else {
      const u = (k.t - a.t) / (b.t - a.t)
      for (let c = 0; c < k.coords.length && ok; c++) if (Math.abs(a.coords[c]! + (b.coords[c]! - a.coords[c]!) * u - k.coords[c]!) > KEY_TOLERANCE) ok = false
    }
    if (!ok) kept.push(k)
  }
  const last = keys[keys.length - 1]!
  const prev = kept[kept.length - 1]!
  if (!(prev.hold && last.coords.every((v, c) => Math.abs(v - prev.coords[c]!) <= KEY_TOLERANCE))) kept.push(last)
  return kept
}

function nodePath(n: NodeRec, coords: number[]): Path {
  const loops: { points: Vec[]; corners: boolean[] }[] = []
  let o = 0
  n.counts.forEach((count, j) => {
    const points: Vec[] = []
    for (let i = 0; i < count; i++) points.push([coords[o + 2 * i]!, coords[o + 2 * i + 1]!])
    o += 2 * count
    loops.push({ points, corners: n.corners[j]! })
  })
  return loopsToPath(loops)
}

function colorOf(c: Rgb): Color {
  return [c[0], c[1], c[2], 255]
}

export async function trace(file: string, opts: TraceOptions = {}): Promise<TraceResult> {
  const log = opts.log ?? (() => {})
  const info = probe(file)
  const width = opts.width ?? info.width
  const height = opts.height ?? Math.round((width * info.height) / info.width)
  const fps = opts.fps ?? info.fps
  const chunkDuration = opts.chunkDuration ?? 10
  const contour: ContourOptions = { tolerance: opts.tolerance ?? 0.7, minHole: opts.minHole ?? 6, cornerAngle: opts.cornerAngle ?? 60 }
  const minArea = opts.minArea ?? 20

  log(`pass 1: ${info.frames} frames at ${width}x${height}`)
  const samples: number[] = []
  const sparse: Uint8Array[] = []
  const frames: number[] = []
  const every = Math.max(1, Math.floor(info.frames / 24))
  let count = 0
  const smalls: Uint8Array[] = []
  const lumas: Uint8Array[] = []
  for await (const f of readFrames(file, width, height, opts.fps)) {
    if (count % every === 0) sparse.push(f)
    smalls.push(downsample(f, width, height))
    if (opts.plate !== 'none') lumas.push(luma(f, width, height))
    frames.push(count)
    count++
  }
  const plate: Plate | null = opts.plate === 'none' ? null : await buildPlate(sparse, smalls, lumas, every, width, height, opts.plate === 'raster', opts.plateCrf ?? 18, log)
  for (const [i, f] of sparse.entries()) samplePixels(f, width, height, samples, 2, plate ? foregroundMask(f, plate, i * every, width, height) : undefined)
  const palette = buildPalette(samples, opts.colors ?? 64)
  log(`palette: ${palette.length} colors${plate ? ', raster background plate' : ''}`)
  const q = new Quantizer(palette)

  const chunks: { start: number; end: number; builder: ChunkBuilder }[] = []
  let builder = new ChunkBuilder(1 / fps)
  let chunkStart = 0
  let prev: Uint8Array | null = null
  let prevMask: Uint8Array | null = null
  let drawings = 0
  let f = 0
  for await (const frame of readFrames(file, width, height, opts.fps)) {
    const t = f / fps
    if (t >= chunkStart + chunkDuration - 1e-9) {
      builder.close(t)
      chunks.push({ start: chunkStart, end: t, builder })
      builder = new ChunkBuilder(1 / fps)
      chunkStart = t
      prev = null
    }
    const mask = plate ? foregroundMask(frame, plate, f, width, height) : undefined
    if (!prev || !same(prev, frame, prevMask, mask ?? null, width * height)) {
      const regions = segment(frame, width, height, q, minArea, mask)
      builder.drawing(stackedShapes(regions, contour), t)
      drawings++
    }
    prev = frame
    prevMask = mask ?? null
    f++
    if (f % 24 === 0) log(`traced ${f}/${count} frames`)
  }
  const end = f / fps
  builder.close(end)
  chunks.push({ start: chunkStart, end, builder })

  const assets: Asset[] = []
  const nodes: SceneNode[] = []
  if (plate) {
    assets.push(plate.image)
    nodes.push(plate.node(0, fps))
  }
  let nodeCount = 0
  let linked = 0
  let created = 0
  let keyCount = 0
  for (const c of chunks) {
    linked += c.builder.linked
    created += c.builder.created
    const children: SceneNode[] = c.builder.order.map(n => {
      const keys = reduceKeys(n.keys)
      keyCount += keys.length
      const path: Track<Path> =
        keys.length === 1
          ? nodePath(n, keys[0]!.coords)
          : keys.map((k): Keyframe<Path> => (k.hold ? { t: k.t, v: nodePath(n, k.coords), ease: 'hold' } : { t: k.t, v: nodePath(n, k.coords) }))
      const node: SceneNode = { type: 'shape', path, fill: { type: 'solid', color: colorOf(palette[n.color]!) }, fillRule: 'evenodd' }
      if (n.start > c.start + 1e-9) node.start = n.start
      if (n.end < c.end - 1e-9) node.end = n.end
      return node
    })
    nodeCount += children.length
    const g: SceneNode = { type: 'group', children }
    if (c.start > 0) g.start = c.start
    if (c !== chunks[chunks.length - 1]) g.end = c.end
    nodes.push(g)
  }
  const bg = palette[0]!
  const scene: Scene = { width, height, duration: end, loop: false, background: plate ? [0, 0, 0, 255] : colorOf(bg), nodes }
  if (assets.length) scene.assets = assets
  return { scene, fps, width, height, frames: f, palette, plate: !!plate, stats: { drawings, nodes: nodeCount, linked, created, keyframes: keyCount } }
}

function same(a: Uint8Array, b: Uint8Array, ma: Uint8Array | null, mb: Uint8Array | null, n: number): boolean {
  let diff = 0
  const limit = n * 0.0005
  for (let i = 0; i < n; i++) {
    if (ma && mb && !ma[i] && !mb[i]) continue
    const o = i * 4
    if (Math.abs(a[o]! - b[o]!) + Math.abs(a[o + 1]! - b[o + 1]!) + Math.abs(a[o + 2]! - b[o + 2]!) > 30 && ++diff > limit) return false
  }
  return true
}

function luma(f: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = (f[i * 4]! * 2 + f[i * 4 + 1]! * 5 + f[i * 4 + 2]!) >> 3
  return out
}

export function downsample(f: Uint8Array, width: number, height: number): Uint8Array {
  const w = width >> 2
  const h = height >> 2
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const o = ((y * 4 + dy) * width + x * 4 + dx) * 4
          s += f[o]! * 2 + f[o + 1]! * 5 + f[o + 2]!
        }
      }
      out[y * w + x] = s >> 7
    }
  }
  return out
}

