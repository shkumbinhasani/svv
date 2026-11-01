import { flattenPath, sameTopology, unifyPaths, type Topology } from './path.ts'
import { layoutText } from './text.ts'
import {
  isKeyframes,
  type Asset,
  type BlendMode,
  type Filter,
  type Color,
  type Easing,
  type GradientStop,
  type LineCap,
  type LineJoin,
  type Paint,
  type Path,
  type Scene,
  type SceneNode,
  type Track,
  type Vec,
} from './model.ts'

export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export type ResolvedPaint =
  | { type: 'solid'; color: Color }
  | { type: 'linear'; from: Vec; to: Vec; stops: GradientStop[] }
  | { type: 'radial'; center: Vec; radius: number; stops: GradientStop[] }

export type CanvasBlend = GlobalCompositeOperation

export interface PathItem {
  kind: 'path'
  matrix: Matrix
  opacity: number
  blend: CanvasBlend
  topology: Topology
  coords: ArrayLike<number>
  fillRule: 'nonzero' | 'evenodd'
  fill?: ResolvedPaint
  stroke?: { paint: ResolvedPaint; width: number; join: LineJoin; cap: LineCap }
}

export interface MediaItem {
  kind: 'image' | 'video'
  matrix: Matrix
  opacity: number
  blend: CanvasBlend
  asset: number
  rect: [number, number, number, number]
  time: number
}

export type ResolvedFilter =
  | { type: 'blur'; radius: number }
  | { type: 'glow'; radius: number; color: Color; strength: number }
  | { type: 'shadow'; dx: number; dy: number; radius: number; color: Color }

export interface LayerItem {
  kind: 'layer'
  matrix: Matrix
  opacity: number
  blend: CanvasBlend
  filters: ResolvedFilter[]
  mask?: { invert: boolean; items: RenderItem[] }
  items: RenderItem[]
}

export type RenderItem = PathItem | MediaItem | LayerItem

export type DrawItem = PathItem

const PRESETS: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
  easeInOut: [0.42, 0, 0.58, 1],
}

export function cubicBezierEase(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3
  const dx = (s: number) => 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s
  return u => {
    if (u <= 0) return 0
    if (u >= 1) return 1
    let s = u
    for (let i = 0; i < 8; i++) {
      const err = bx(s) - u
      if (Math.abs(err) < 1e-7) return by(s)
      const d = dx(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = u
    for (let i = 0; i < 40; i++) {
      const x = bx(s)
      if (Math.abs(x - u) < 1e-7) break
      if (x < u) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return by(s)
  }
}

const easeCache = new Map<string, (u: number) => number>()

function easeFn(e: Easing): ((u: number) => number) | null {
  if (e === 'linear' || e === 'hold' || e === 'smooth') return null
  const params = Array.isArray(e) ? e : PRESETS[e]!
  const key = params.join(',')
  let f = easeCache.get(key)
  if (!f) easeCache.set(key, (f = cubicBezierEase(...params)))
  return f
}

export type Sampler = (t: number) => ArrayLike<number>

export function sampler(times: number[], values: ArrayLike<number>[], eases: Easing[]): Sampler {
  const n = times.length
  if (n === 1) return () => values[0]!
  const dim = values[0]!.length
  const fns = eases.map(easeFn)
  const tangent = (i: number, d: number) => {
    const a = Math.max(0, i - 1)
    const b = Math.min(n - 1, i + 1)
    const dt = times[b]! - times[a]!
    return dt > 0 ? (values[b]![d]! - values[a]![d]!) / dt : 0
  }
  const out = new Float64Array(dim)
  return t => {
    if (t <= times[0]!) return values[0]!
    if (t >= times[n - 1]!) return values[n - 1]!
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (times[mid]! <= t) lo = mid
      else hi = mid
    }
    const t0 = times[lo]!
    const t1 = times[hi]!
    const span = t1 - t0
    const ease = eases[lo] ?? 'linear'
    if (ease === 'hold' || span <= 0) return values[span <= 0 ? hi : lo]!
    const u = (t - t0) / span
    const a = values[lo]!
    const b = values[hi]!
    if (ease === 'smooth') {
      const u2 = u * u
      const u3 = u2 * u
      const h00 = 2 * u3 - 3 * u2 + 1
      const h10 = u3 - 2 * u2 + u
      const h01 = -2 * u3 + 3 * u2
      const h11 = u3 - u2
      for (let d = 0; d < dim; d++) out[d] = h00 * a[d]! + h10 * span * tangent(lo, d) + h01 * b[d]! + h11 * span * tangent(hi, d)
      return out
    }
    const f = fns[lo]
    const k = f ? f(u) : u
    for (let d = 0; d < dim; d++) out[d] = a[d]! + (b[d]! - a[d]!) * k
    return out
  }
}

function numberSampler(track: Track<number> | undefined, def: number): (t: number) => number {
  if (track === undefined) return () => def
  if (!isKeyframes(track)) return () => track
  const s = sampler(
    track.map(k => k.t),
    track.map(k => [k.v]),
    track.map(k => k.ease ?? 'linear'),
  )
  return t => s(t)[0]!
}

function colorSampler(track: Track<Color>): (t: number) => Color {
  if (!isKeyframes(track)) return () => track
  const s = sampler(
    track.map(k => k.t),
    track.map(k => k.v),
    track.map(k => k.ease ?? 'linear'),
  )
  return t => Array.from(s(t)) as Color
}

function pathSampler(track: Track<Path>): (t: number) => { topology: Topology; coords: ArrayLike<number> } {
  if (!isKeyframes(track)) {
    const f = flattenPath(track)
    return () => f
  }
  let paths = track.map(k => k.v)
  let flat = paths.map(flattenPath)
  if (!flat.every(f => sameTopology(f.topology, flat[0]!.topology))) {
    paths = unifyPaths(paths)
    flat = paths.map(flattenPath)
  }
  const topology = flat[0]!.topology
  const s = sampler(
    track.map(k => k.t),
    flat.map(f => f.coords),
    track.map(k => k.ease ?? 'linear'),
  )
  return t => ({ topology, coords: s(t) })
}

function paintSampler(p: Paint): (t: number) => ResolvedPaint {
  if (p.type !== 'solid') return () => p
  const c = colorSampler(p.color)
  return t => ({ type: 'solid', color: c(t) })
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

type Compiled = (t: number, parent: Matrix, opacity: number, out: RenderItem[]) => void

export function canvasBlend(b: BlendMode | undefined): CanvasBlend {
  if (!b || b === 'normal') return 'source-over'
  if (b === 'add') return 'lighter'
  return b
}

function filterSampler(f: Filter): (t: number) => ResolvedFilter {
  const radius = numberSampler(f.radius, 0)
  if (f.type === 'blur') return t => ({ type: 'blur', radius: radius(t) })
  const color = colorSampler(f.color)
  if (f.type === 'glow') {
    const strength = numberSampler(f.strength, 1)
    return t => ({ type: 'glow', radius: radius(t), color: color(t), strength: strength(t) })
  }
  const dx = numberSampler(f.dx, 0)
  const dy = numberSampler(f.dy, 0)
  return t => ({ type: 'shadow', dx: dx(t), dy: dy(t), radius: radius(t), color: color(t) })
}

function compileNode(node: SceneNode, defs: Compiled[], assets: Asset[]): Compiled {
  const tf = node.transform
  const x = numberSampler(tf?.x, 0)
  const y = numberSampler(tf?.y, 0)
  const rot = numberSampler(tf?.rotation, 0)
  const sx = numberSampler(tf?.scaleX, 1)
  const sy = numberSampler(tf?.scaleY, 1)
  const [ax, ay] = tf?.anchor ?? [0, 0]
  const op = numberSampler(node.opacity, 1)
  const start = node.start ?? -Infinity
  const end = node.end ?? Infinity
  const blend = canvasBlend(node.blend)
  const filters = (node.filters ?? []).map(filterSampler)
  const mask = node.mask ? { invert: !!node.mask.invert, node: compileNode(node.mask.node, defs, assets) } : null
  const leaf = node.type === 'shape' || node.type === 'text' || node.type === 'image' || node.type === 'video'
  const layered = filters.length > 0 || !!mask || !!node.isolate || (blend !== 'source-over' && !leaf)
  const local = (t: number): Matrix | null => {
    if (!tf) return null
    const r = (rot(t) * Math.PI) / 180
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const kx = sx(t)
    const ky = sy(t)
    const a = cos * kx
    const b = sin * kx
    const c = -sin * ky
    const d = cos * ky
    return [a, b, c, d, x(t) - (a * ax + c * ay), y(t) - (b * ax + d * ay)]
  }
  let body: Compiled
  switch (node.type) {
    case 'group': {
      const children = node.children.map(c => compileNode(c, defs, assets))
      body = (t, m, o, out) => {
        for (const c of children) c(t, m, o, out)
      }
      break
    }
    case 'use': {
      const def = defs[node.ref]
      if (!def) throw new Error(`use ref ${node.ref} is not defined before use`)
      body = def
      break
    }
    case 'shape':
    case 'text': {
      const geometry = node.type === 'shape' ? pathSampler(node.path) : textSampler(node, assets)
      const fill = node.fill ? paintSampler(node.fill) : null
      const strokePaint = node.stroke ? paintSampler(node.stroke.paint) : null
      const strokeWidth = numberSampler(node.stroke?.width, 1)
      const join = node.stroke?.join ?? 'miter'
      const cap = node.stroke?.cap ?? 'butt'
      const fillRule = node.type === 'shape' ? (node.fillRule ?? 'nonzero') : 'nonzero'
      const itemBlend = layered ? 'source-over' : blend
      body = (t, m, o, out) => {
        const p = geometry(t)
        const item: PathItem = { kind: 'path', matrix: m, opacity: o, blend: itemBlend, topology: p.topology, coords: Array.from(p.coords), fillRule }
        if (fill) item.fill = fill(t)
        if (strokePaint) item.stroke = { paint: strokePaint(t), width: strokeWidth(t), join, cap }
        out.push(item)
      }
      break
    }
    case 'image':
    case 'video': {
      const kind = node.type
      const rect: [number, number, number, number] = [node.x ?? 0, node.y ?? 0, node.width, node.height]
      const asset = node.asset
      if (assets[asset]?.type !== kind) throw new Error(`${kind} node refers to asset ${asset}, which is not a ${kind}`)
      const itemBlend = layered ? 'source-over' : blend
      body = (t, m, o, out) => {
        out.push({ kind, matrix: m, opacity: o, blend: itemBlend, asset, rect, time: t })
      }
      break
    }
  }
  return (t, parent, opacity, out) => {
    if (t < start || t >= end) return
    const o = op(t)
    if (o <= 0 || opacity <= 0) return
    const l = local(t)
    const m = l ? multiply(parent, l) : parent
    if (!layered) return body(t, m, opacity * o, out)
    const items: RenderItem[] = []
    body(t, m, 1, items)
    const layer: LayerItem = { kind: 'layer', matrix: m, opacity: opacity * o, blend, filters: filters.map(f => f(t)), items }
    if (mask) {
      const maskItems: RenderItem[] = []
      mask.node(t, m, 1, maskItems)
      layer.mask = { invert: mask.invert, items: maskItems }
    }
    out.push(layer)
  }
}

function textSampler(node: Extract<SceneNode, { type: 'text' }>, assets: Asset[]): (t: number) => { topology: Topology; coords: ArrayLike<number> } {
  const font = assets[node.font]
  if (font?.type !== 'font') throw new Error(`text node refers to asset ${node.font}, which is not a font`)
  const size = numberSampler(node.size, 16)
  const layout = layoutText(font, node.text, node.align ?? 'left', node.letterSpacing ?? 0, node.lineHeight ?? 1.2)
  let lastSize = NaN
  let last: { topology: Topology; coords: ArrayLike<number> } = { topology: layout.topology, coords: [] }
  return t => {
    const s = size(t)
    if (s !== lastSize) {
      lastSize = s
      last = { topology: layout.topology, coords: layout.coords(s) }
    }
    return last
  }
}

export interface CompiledScene {
  scene: Scene
  sample(time: number): RenderItem[]
  sceneTime(time: number): number
}

export function sceneTimeOf(scene: { duration: number; loop?: boolean }, time: number): number {
  const d = scene.duration
  if (d <= 0) return 0
  if (scene.loop ?? true) return ((time % d) + d) % d
  return Math.max(0, Math.min(d, time))
}

export function compile(scene: Scene): CompiledScene {
  const assets = scene.assets ?? []
  const defs: Compiled[] = []
  for (const d of scene.defs ?? []) defs.push(compileNode(d, defs, assets))
  const nodes = scene.nodes.map(n => compileNode(n, defs, assets))
  const sceneTime = (time: number) => sceneTimeOf(scene, time)
  return {
    scene,
    sceneTime,
    sample(time) {
      const t = sceneTime(time)
      const out: RenderItem[] = []
      for (const n of nodes) n(t, IDENTITY, 1, out)
      return out
    },
  }
}

export function flattenItems(items: RenderItem[]): PathItem[] {
  return items.flatMap(i => (i.kind === 'path' ? [i] : i.kind === 'layer' ? flattenItems(i.items) : []))
}
