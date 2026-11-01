import { BitReader, BitWriter } from './rangecoder.ts'
import { flattenPath, sameTopology, unflattenPath, unifyPaths, type Topology } from './path.ts'
import { chunkBounds, sliceScene, usedAssets, type ChunkScene } from './chunk.ts'
import {
  BLEND_MODES,
  isKeyframes,
  type Asset,
  type AudioSegment,
  type Color,
  type Filter,
  type FontAsset,
  type ImageMime,
  type ImageNode,
  type VideoNode,
  type Mask,
  type Stroke,
  type VideoFrame,
  type Easing,
  type GradientStop,
  type Keyframe,
  type LineCap,
  type LineJoin,
  type Paint,
  type Path,
  type Scene,
  type SceneNode,
  type Track,
  type Transform,
} from './model.ts'

export const MAGIC = [0x53, 0x56, 0x56]
export const VERSION = 2

export interface EncodeOptions {
  timescale?: number
  precision?: number
  chunkDuration?: number
}

const NODE_TYPES = ['shape', 'group', 'use', 'text', 'image', 'video'] as const
const FILTER_TYPES = ['blur', 'glow', 'shadow'] as const
const ALIGNS = ['left', 'center', 'right'] as const
const ASSET_TYPES = ['font', 'image', 'video', 'audio'] as const
const IMAGE_MIMES: ImageMime[] = ['image/avif', 'image/webp', 'image/png', 'image/jpeg']

const EASES: Easing[] = ['linear', 'hold', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'smooth']
const CUSTOM_EASE = 7
const JOINS: LineJoin[] = ['miter', 'round', 'bevel']
const CAPS: LineCap[] = ['butt', 'round', 'square']
const COLOR_CACHE = 64

interface NumberProp {
  key: string
  step: number | 'coord'
  def: number
}

const PROP = {
  x: { key: 'x', step: 'coord', def: 0 },
  y: { key: 'y', step: 'coord', def: 0 },
  rotation: { key: 'rot', step: 1 / 256, def: 0 },
  scaleX: { key: 'sx', step: 1 / 4096, def: 1 },
  scaleY: { key: 'sy', step: 1 / 4096, def: 1 },
  opacity: { key: 'op', step: 1 / 255, def: 1 },
  strokeWidth: { key: 'sw', step: 'coord', def: 1 },
  fontSize: { key: 'fs', step: 'coord', def: 16 },
  radius: { key: 'fr', step: 'coord', def: 0 },
  dx: { key: 'fdx', step: 'coord', def: 0 },
  dy: { key: 'fdy', step: 'coord', def: 0 },
  strength: { key: 'fk', step: 1 / 256, def: 1 },
} satisfies Record<string, NumberProp>

const XF_KEYS = ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const

export function defaultPrecision(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height, 1e-6) / 32768))
}

function easeIndex(e: Easing | undefined): number {
  if (e === undefined) return 0
  if (Array.isArray(e)) return CUSTOM_EASE
  const i = EASES.indexOf(e)
  if (i < 0) throw new Error(`unknown easing ${e}`)
  return i
}

class Timing {
  times: number[] = []
  eases: Easing[] = []
}

const RECENT = 32

class Recent<T> {
  private items: { id: string; value: T }[] = []

  find(id: string): number {
    return this.items.findIndex(i => i.id === id)
  }

  take(index: number): T {
    const item = this.items[index]
    if (!item) throw new Error('corrupt SVV data: bad back-reference')
    this.items.splice(index, 1)
    this.items.unshift(item)
    return item.value
  }

  add(id: string, value: T) {
    this.items.unshift({ id, value })
    if (this.items.length > RECENT) this.items.pop()
  }
}

const sintCost = (v: number) => (v === 0 ? 0.3 : 2 * Math.log2(Math.abs(v) + 1) + 1.5)
const uintCost = (v: number) => 2 * Math.log2(v + 1) + 1

function predictValue(mode: number, i: number, values: number[], base: number): number {
  if (i === 0) return base
  if (mode === 1 && i >= 2) return 2 * values[i - 1]! - values[i - 2]!
  if (mode === 2 && i >= 2) return values[i - 2]!
  return values[i - 1]!
}

function predictDt(mode: number, i: number, dts: number[]): number {
  return mode === 1 && i >= 2 ? dts[i - 2]! : 0
}

class SceneWriter {
  readonly w = new BitWriter()
  private timings = new Recent<true>()
  private numbers = new Map<string, Recent<true>>()
  private paths = new Recent<true>()
  private colors: string[] = []
  private coord: number

  constructor(
    private timescale: number,
    precision: number,
    private assets: Asset[] = [],
  ) {
    this.coord = 2 ** precision
  }

  q(v: number, step: number | 'coord'): number {
    return Math.round(v / (step === 'coord' ? this.coord : step))
  }

  ticks(t: number): number {
    return Math.max(0, Math.round(t * this.timescale))
  }

  chunk(c: ChunkScene) {
    const { w } = this
    w.uint('defs', c.defs.length)
    c.defs.forEach((n, i) => this.node(n, i))
    w.uint('nodes', c.nodes.length)
    for (const n of c.nodes) this.node(n, c.defs.length)
  }

  string(key: string, text: string) {
    const bytes = new TextEncoder().encode(text)
    this.w.uint(`${key}.n`, bytes.length)
    for (const b of bytes) this.w.symbol(key, b, 8)
  }

  font(f: FontAsset) {
    const { w } = this
    w.uint('font.upm', Math.round(f.unitsPerEm))
    w.sint('font.asc', Math.round(f.ascent))
    w.sint('font.desc', Math.round(f.descent))
    const glyphs = [...f.glyphs].sort((a, b) => a.char.codePointAt(0)! - b.char.codePointAt(0)!)
    w.uint('font.n', glyphs.length)
    let prev = 0
    for (const g of glyphs) {
      const cp = g.char.codePointAt(0)!
      if (cp <= prev && prev !== 0) throw new Error('duplicate glyph in font')
      w.uint('font.cp', cp - prev)
      prev = cp
      w.uint('font.adv', Math.max(0, Math.round(g.advance)))
      const flat = this.quantizePath(g.path)
      this.topology(flat.topology)
      this.geometry(flat.topology, flat.coords)
    }
    const index = new Map(glyphs.map((g, i) => [g.char, i]))
    const kerning = (f.kerning ?? []).filter(([a, b]) => index.has(a) && index.has(b))
    w.uint('font.kern', kerning.length)
    for (const [a, b, v] of kerning) {
      w.uint('kern.a', index.get(a)!)
      w.uint('kern.b', index.get(b)!)
      w.sint('kern.v', Math.round(v))
    }
  }

  assetRef(key: string, index: number, type: Asset['type']) {
    const a = this.assets[index]
    if (!a || a.type !== type) throw new Error(`${key}: asset ${index} is not a ${type}`)
    this.w.uint(key, index)
  }

  fillStroke(fill: Paint | undefined, stroke: Stroke | undefined) {
    const { w } = this
    w.bit('shape.fill', !!fill)
    if (fill) this.paint(fill)
    w.bit('shape.stroke', !!stroke)
    if (stroke) {
      this.paint(stroke.paint)
      this.numberTrack(stroke.width, PROP.strokeWidth)
      w.symbol('stroke.join', JOINS.indexOf(stroke.join ?? 'miter'), 2)
      w.symbol('stroke.cap', CAPS.indexOf(stroke.cap ?? 'butt'), 2)
    }
  }

  effects(n: SceneNode, defCount: number) {
    const { w } = this
    const blend = n.blend && n.blend !== 'normal' ? n.blend : null
    w.bit('fx.blend', !!blend)
    if (blend) w.symbol('fx.mode', BLEND_MODES.indexOf(blend), 5)
    w.bit('fx.isolate', !!n.isolate)
    const filters = n.filters ?? []
    w.uint('fx.filters', filters.length)
    for (const f of filters) {
      w.symbol('filter', FILTER_TYPES.indexOf(f.type), 2)
      if (f.type === 'shadow') {
        this.numberTrack(f.dx, PROP.dx)
        this.numberTrack(f.dy, PROP.dy)
      }
      this.numberTrack(f.radius, PROP.radius)
      if (f.type !== 'blur') this.colorTrack(f.color)
      if (f.type === 'glow') {
        w.bit('glow.k', f.strength !== undefined)
        if (f.strength !== undefined) this.numberTrack(f.strength, PROP.strength)
      }
    }
    w.bit('fx.mask', !!n.mask)
    if (n.mask) {
      w.bit('mask.invert', !!n.mask.invert)
      this.node(n.mask.node, defCount)
    }
  }

  color(c: Color) {
    const rgba = clampColor(c)
    const id = rgba.join(',')
    const idx = this.colors.indexOf(id)
    this.w.uint('color.idx', idx + 1)
    if (idx >= 0) {
      this.colors.splice(idx, 1)
    } else {
      this.w.symbol('color.r', rgba[0]!, 8)
      this.w.symbol('color.g', rgba[1]!, 8)
      this.w.symbol('color.b', rgba[2]!, 8)
      this.w.symbol('color.a', rgba[3]!, 8)
    }
    this.colors.unshift(id)
    if (this.colors.length > COLOR_CACHE) this.colors.pop()
  }

  timingId<T>(kfs: Keyframe<T>[]): string {
    const times = kfs.map(k => this.ticks(k.t))
    const eases = kfs.slice(0, -1).map(k => {
      const e = k.ease ?? 'linear'
      return Array.isArray(e) ? e.map(v => Math.round(v * 255)).join('/') : e
    })
    return `${times.join(',')}|${eases.join(',')}`
  }

  timing<T>(kfs: Keyframe<T>[]) {
    const { w } = this
    const t = new Timing()
    t.times = kfs.map(k => this.ticks(k.t))
    t.eases = kfs.slice(0, -1).map(k => k.ease ?? 'linear')
    for (let i = 1; i < t.times.length; i++) {
      if (t.times[i]! < t.times[i - 1]!) throw new Error('keyframes must be sorted by time')
    }
    const id = this.timingId(kfs)
    const ref = this.timings.find(id)
    w.uint('kf.ref', ref + 1)
    if (ref >= 0) {
      this.timings.take(ref)
      return
    }
    w.uint('kf.n', kfs.length - 1)
    w.uint('kf.t0', t.times[0]!)
    const dts = t.times.slice(1).map((v, i) => v - t.times[i]!)
    if (dts.length >= 3) {
      const cost = (mode: number) => dts.reduce((s, d, i) => s + sintCost(d - predictDt(mode, i, dts)), 0)
      const mode = cost(1) < cost(0) ? 1 : 0
      w.bit('kf.mode', mode === 1)
      dts.forEach((d, i) => (mode === 1 && i >= 2 ? w.sint('kf.ddt', d - predictDt(1, i, dts)) : w.uint('kf.dt', d)))
    } else for (const d of dts) w.uint('kf.dt', d)
    let prev = 0
    for (const e of t.eases) {
      const s = easeIndex(e)
      w.symbol(`ease.${prev}`, s, 3)
      if (s === CUSTOM_EASE) {
        const [x1, y1, x2, y2] = e as number[]
        w.symbol('ease.x', Math.round(Math.max(0, Math.min(1, x1!)) * 255), 8)
        w.sint('ease.y', Math.round(y1! * 255))
        w.symbol('ease.x', Math.round(Math.max(0, Math.min(1, x2!)) * 255), 8)
        w.sint('ease.y', Math.round(y2! * 255))
      }
      prev = s
    }
    this.timings.add(id, true)
  }

  numberTrack(track: Track<number>, prop: NumberProp) {
    const { w } = this
    const anim = isKeyframes(track)
    w.bit(`${prop.key}.anim`, anim)
    const base = this.q(prop.def, prop.step)
    if (!anim) {
      w.sint(`${prop.key}.v`, this.q(track, prop.step) - base)
      return
    }
    const values = track.map(k => this.q(k.v, prop.step))
    const id = `${this.timingId(track)}|${values.join(',')}`
    let recent = this.numbers.get(prop.key)
    if (!recent) this.numbers.set(prop.key, (recent = new Recent()))
    const ref = recent.find(id)
    w.uint(`${prop.key}.ref`, ref + 1)
    if (ref >= 0) {
      recent.take(ref)
      return
    }
    this.timing(track)
    let mode = 0
    if (values.length >= 3) {
      let best = Infinity
      for (let m = 0; m < 3; m++) {
        const cost = values.reduce((s, v, i) => s + sintCost(v - predictValue(m, i, values, base)), 0)
        if (cost < best) {
          best = cost
          mode = m
        }
      }
      w.symbol('num.pred', mode, 2)
    }
    values.forEach((v, i) => w.sint(i >= 2 && mode ? `${prop.key}.p${mode}` : `${prop.key}.d`, v - predictValue(mode, i, values, base)))
    recent.add(id, true)
  }

  colorTrack(track: Track<Color>) {
    const anim = isKeyframes(track)
    this.w.bit('color.anim', anim)
    if (!anim) return this.color(track)
    this.timing(track)
    this.color(track[0]!.v)
    let prev = clampColor(track[0]!.v)
    for (const k of track.slice(1)) {
      const cur = clampColor(k.v)
      cur.forEach((v, i) => this.w.sint('color.d', v - prev[i]!))
      prev = cur
    }
  }

  stops(stops: GradientStop[]) {
    this.w.uint('grad.n', stops.length - 1)
    for (const s of stops) {
      this.w.symbol('grad.off', Math.round(Math.max(0, Math.min(1, s.offset)) * 255), 8)
      this.color(s.color)
    }
  }

  paint(p: Paint) {
    const { w } = this
    const type = p.type === 'solid' ? 0 : p.type === 'linear' ? 1 : 2
    w.symbol('paint', type, 2)
    if (p.type === 'solid') return this.colorTrack(p.color)
    if (p.type === 'linear') {
      for (const v of [...p.from, ...p.to]) w.sint('grad.p', this.q(v, 'coord'))
    } else {
      for (const v of p.center) w.sint('grad.p', this.q(v, 'coord'))
      w.uint('grad.r', this.q(p.radius, 'coord'))
    }
    this.stops(p.stops)
  }

  topology(t: Topology) {
    const { w } = this
    w.uint('path.subs', t.subpaths.length)
    for (const sp of t.subpaths) {
      w.uint('path.segs', sp.cubic.length)
      w.bit('path.closed', sp.closed)
      w.bit('path.spline', !!sp.spline)
      let prev = 0
      if (sp.spline) {
        for (const c of sp.corners!) {
          w.bit(`path.corner.${prev}`, c)
          prev = c ? 1 : 0
        }
        continue
      }
      for (const c of sp.cubic) {
        w.bit(`path.cubic.${prev}`, c)
        prev = c ? 1 : 0
      }
    }
  }

  geometry(t: Topology, coords: number[]) {
    const { w } = this
    let i = 0
    let cx = 0
    let cy = 0
    for (const sp of t.subpaths) {
      const sx = coords[i++]!
      const sy = coords[i++]!
      w.sint('path.mx', sx - cx)
      w.sint('path.my', sy - cy)
      cx = sx
      cy = sy
      let pc2x = NaN
      let pc2y = NaN
      if (sp.spline) {
        for (let k = 0; k < sp.cubic.length; k++) {
          const x = coords[i++]!
          const y = coords[i++]!
          w.sint('path.px', x - cx)
          w.sint('path.py', y - cy)
          cx = x
          cy = y
        }
        continue
      }
      for (const cubic of sp.cubic) {
        if (!cubic) {
          const x = coords[i++]!
          const y = coords[i++]!
          w.sint('path.lx', x - cx)
          w.sint('path.ly', y - cy)
          cx = x
          cy = y
          pc2x = NaN
          continue
        }
        const c1x = coords[i++]!
        const c1y = coords[i++]!
        const c2x = coords[i++]!
        const c2y = coords[i++]!
        const x = coords[i++]!
        const y = coords[i++]!
        w.sint('path.cx', x - cx)
        w.sint('path.cy', y - cy)
        const [p1x, p1y] = predictC1(cx, cy, x, y, pc2x, pc2y)
        const smooth = !Number.isNaN(pc2x)
        w.sint(smooth ? 'path.s1x' : 'path.c1x', c1x - p1x)
        w.sint(smooth ? 'path.s1y' : 'path.c1y', c1y - p1y)
        w.sint('path.c2x', c2x - Math.round(x + (cx - x) / 3))
        w.sint('path.c2y', c2y - Math.round(y + (cy - y) / 3))
        cx = x
        cy = y
        pc2x = c2x
        pc2y = c2y
      }
    }
  }

  quantizePath(p: Path): { topology: Topology; coords: number[] } {
    const f = flattenPath(p)
    return { topology: f.topology, coords: f.coords.map(v => this.q(v, 'coord')) }
  }

  pathTrack(track: Track<Path>) {
    const { w } = this
    const anim = isKeyframes(track)
    let paths = anim ? track.map(k => k.v) : [track]
    if (anim) {
      const topo = paths.map(p => flattenPath(p).topology)
      if (!topo.every(t => sameTopology(t, topo[0]!))) paths = unifyPaths(paths)
    }
    const flat = paths.map(p => this.quantizePath(p))
    const id = `${anim ? this.timingId(track) : 'static'}|${JSON.stringify(flat[0]!.topology)}|${flat.map(f => f.coords.join(',')).join(';')}`
    const ref = this.paths.find(id)
    w.uint('path.ref', ref + 1)
    if (ref >= 0) {
      this.paths.take(ref)
      return
    }
    w.bit('path.anim', anim)
    if (anim) this.timing(track)
    this.topology(flat[0]!.topology)
    this.geometry(flat[0]!.topology, flat[0]!.coords)
    for (let k = 1; k < flat.length; k++) {
      const cur = flat[k]!.coords
      const prev = flat[k - 1]!.coords
      const prev2 = k > 1 ? flat[k - 2]!.coords : null
      let best = 0
      let bestCost = Infinity
      for (let p = 0; p < 4; p++) {
        if ((p === 1 || p === 3) && !prev2) continue
        const cost = residuals(p, cur, prev, prev2).reduce((s, r) => s + sintCost(r), 0)
        if (cost < bestCost) {
          bestCost = cost
          best = p
        }
      }
      w.symbol('path.pred', best, 2)
      const res = residuals(best, cur, prev, prev2)
      const exact = res.every(r => r === 0)
      w.bit('path.exact', exact)
      if (!exact) for (const r of res) w.sint(`path.r${best}`, r)
    }
    this.paths.add(id, true)
  }

  transform(t: Transform | undefined) {
    const { w } = this
    const present = !!t && (XF_KEYS.some(k => t[k] !== undefined) || !!t.anchor)
    w.bit('xf', present)
    if (!present || !t) return
    for (const k of XF_KEYS) {
      if (k === 'scaleY') {
        const uniform = t.scaleX !== undefined && sameTrack(t.scaleX, t.scaleY)
        w.bit('xf.uniform', uniform)
        if (uniform) continue
      }
      const v = t[k]
      w.bit(`xf.${k}`, v !== undefined)
      if (v !== undefined) this.numberTrack(v, PROP[k])
    }
    w.bit('xf.anchor', !!t.anchor)
    if (t.anchor) {
      w.sint('xf.ax', this.q(t.anchor[0], 'coord'))
      w.sint('xf.ay', this.q(t.anchor[1], 'coord'))
    }
  }

  node(n: SceneNode, defCount: number) {
    const { w } = this
    w.symbol('node', NODE_TYPES.indexOf(n.type), 3)
    w.bit('node.start', n.start !== undefined)
    if (n.start !== undefined) w.uint('node.t', this.ticks(n.start))
    w.bit('node.end', n.end !== undefined)
    if (n.end !== undefined) w.uint('node.t', Math.max(0, this.ticks(n.end) - this.ticks(n.start ?? 0)))
    w.bit('node.op', n.opacity !== undefined)
    if (n.opacity !== undefined) this.numberTrack(n.opacity, PROP.opacity)
    this.transform(n.transform)
    const fx = (!!n.blend && n.blend !== 'normal') || !!n.isolate || !!n.filters?.length || !!n.mask
    w.bit('node.fx', fx)
    if (fx) this.effects(n, defCount)
    switch (n.type) {
      case 'group':
        w.uint('group.n', n.children.length)
        for (const c of n.children) this.node(c, defCount)
        break
      case 'use':
        if (n.ref < 0 || n.ref >= defCount) throw new Error(`use ref ${n.ref} out of range`)
        w.uint('use.ref', n.ref)
        break
      case 'shape':
        w.bit('shape.evenodd', n.fillRule === 'evenodd')
        this.pathTrack(n.path)
        this.fillStroke(n.fill, n.stroke)
        break
      case 'text':
        this.assetRef('text.font', n.font, 'font')
        this.string('text.s', n.text)
        this.numberTrack(n.size, PROP.fontSize)
        w.symbol('text.align', ALIGNS.indexOf(n.align ?? 'left'), 2)
        w.bit('text.ls', n.letterSpacing !== undefined)
        if (n.letterSpacing !== undefined) w.sint('text.lsv', this.q(n.letterSpacing, 'coord'))
        w.bit('text.lh', n.lineHeight !== undefined)
        if (n.lineHeight !== undefined) w.uint('text.lhv', Math.max(0, Math.round(n.lineHeight * 256)))
        this.fillStroke(n.fill, n.stroke)
        break
      case 'image':
      case 'video':
        this.assetRef('media.asset', n.asset, n.type)
        w.sint('media.x', this.q(n.x ?? 0, 'coord'))
        w.sint('media.y', this.q(n.y ?? 0, 'coord'))
        w.uint('media.w', Math.max(0, this.q(n.width, 'coord')))
        w.uint('media.h', Math.max(0, this.q(n.height, 'coord')))
        break
    }
  }
}

function clampColor(c: Color): number[] {
  return c.map(v => Math.max(0, Math.min(255, Math.round(v))))
}

function sameTrack(a: Track<number> | undefined, b: Track<number> | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function predictC1(cx: number, cy: number, x: number, y: number, pc2x: number, pc2y: number): [number, number] {
  if (!Number.isNaN(pc2x)) return [2 * cx - pc2x, 2 * cy - pc2y]
  return [Math.round(cx + (x - cx) / 3), Math.round(cy + (y - cy) / 3)]
}

function predict(p: number, i: number, cur: ArrayLike<number>, prev: ArrayLike<number>, prev2: ArrayLike<number> | null): number {
  if (p === 1 && prev2) return 2 * prev[i]! - prev2[i]!
  if (p === 2 && i >= 2) return prev[i]! + cur[i - 2]! - prev[i - 2]!
  if (p === 3 && prev2) return prev2[i]!
  return prev[i]!
}

function residuals(p: number, cur: number[], prev: number[], prev2: number[] | null): number[] {
  return cur.map((v, i) => v - predict(p, i, cur, prev, prev2))
}

export interface Movie {
  width: number
  height: number
  duration: number
  loop: boolean
  background?: Color
  timescale: number
  precision: number
  audio?: number
  assets: Asset[]
  chunks: ChunkScene[]
}

export function toMovie(scene: Scene, options: EncodeOptions = {}): Movie {
  const timescale = options.timescale ?? 600
  const precision = options.precision ?? defaultPrecision(scene.width, scene.height)
  const chunks = chunkBounds(scene.duration, options.chunkDuration ?? 10).map(([a, b]) => sliceScene(scene, a, b))
  const movie: Movie = { width: scene.width, height: scene.height, duration: scene.duration, loop: scene.loop ?? true, timescale, precision, assets: scene.assets ?? [], chunks }
  if (scene.background) movie.background = scene.background
  if (scene.audio !== undefined) movie.audio = scene.audio
  return movie
}

export function encode(scene: Scene, options: EncodeOptions = {}): Uint8Array {
  return writeMovie(toMovie(scene, options))
}

function varint(out: number[], v: number) {
  if (!Number.isInteger(v) || v < 0) throw new RangeError(`varint ${v}`)
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

const isGlobal = (a: Asset | undefined) => a?.type === 'font' || a?.type === 'image'

interface MediaItem {
  tick: number
  key?: boolean
  data: Uint8Array
}

function mediaItems(a: Asset, ticks: (t: number) => number): MediaItem[] {
  if (a.type === 'video') return a.frames.map(f => ({ tick: ticks(f.t), key: f.key, data: f.data }))
  if (a.type === 'audio') return a.segments.map(s => ({ tick: ticks(s.t), data: s.data }))
  return []
}

export function writeMovie(m: Movie): Uint8Array {
  const header = new SceneWriter(m.timescale, m.precision, m.assets)
  const w = header.w
  w.uint('timescale', m.timescale)
  w.sint('precision', m.precision)
  w.uint('dim', header.q(m.width, 'coord'))
  w.uint('dim', header.q(m.height, 'coord'))
  w.uint('dur', header.ticks(m.duration))
  w.bit('loop', m.loop)
  w.bit('bg', !!m.background)
  if (m.background) header.color(m.background)
  if (m.audio !== undefined && m.assets[m.audio]?.type !== 'audio') throw new Error(`audio: asset ${m.audio} is not audio`)
  w.uint('audio', m.audio === undefined ? 0 : m.audio + 1)
  w.uint('assets', m.assets.length)
  for (const a of m.assets) {
    w.symbol('asset', ASSET_TYPES.indexOf(a.type), 2)
    if (a.type === 'image') {
      w.symbol('img.mime', IMAGE_MIMES.indexOf(a.mime), 2)
      w.uint('img.w', a.width)
      w.uint('img.h', a.height)
    } else if (a.type === 'video') {
      header.string('codec', a.codec)
      w.uint('vid.w', a.width)
      w.uint('vid.h', a.height)
    } else if (a.type === 'audio') {
      header.string('codec', a.codec)
      w.uint('aud.rate', a.sampleRate)
      w.uint('aud.ch', a.channels)
    }
  }
  const headerBytes = w.finish()

  const table: number[] = []
  const payloads: Uint8Array[] = []
  let entryCount = 0
  const emitted = new Set<number>()
  const emitAsset = (i: number) => {
    const a = m.assets[i]!
    let payload: Uint8Array
    if (a.type === 'image') payload = a.data
    else if (a.type === 'font') {
      const fw = new SceneWriter(m.timescale, 0, m.assets)
      fw.font(a)
      payload = fw.w.finish()
    } else return
    emitted.add(i)
    varint(table, 0)
    varint(table, i)
    varint(table, payload.length)
    payloads.push(payload)
    entryCount++
  }
  const ticks = (t: number) => header.ticks(t)
  const starts = m.chunks.map(c => ticks(c.start))
  const media = m.assets.map(a => mediaItems(a, ticks).sort((x, y) => x.tick - y.tick))
  m.chunks.forEach((c, ci) => {
    const deps = [...usedAssets(c.nodes, c.defs)].filter(i => isGlobal(m.assets[i])).sort((a, b) => a - b)
    for (const d of deps) if (!emitted.has(d)) emitAsset(d)
    const sw = new SceneWriter(m.timescale, m.precision, m.assets)
    sw.chunk(c)
    const sceneBytes = sw.w.finish()
    const parts: (Uint8Array | number[])[] = []
    const head: number[] = []
    varint(head, sceneBytes.length)
    parts.push(head, sceneBytes)
    const inChunk = (tick: number) => (ci === 0 || tick >= starts[ci]!) && (ci === m.chunks.length - 1 || tick < starts[ci + 1]!)
    const groups = media.map((items, ai) => ({ ai, items: items.filter(it => inChunk(it.tick)) })).filter(g => g.items.length)
    const mh: number[] = []
    varint(mh, groups.length)
    parts.push(mh)
    for (const g of groups) {
      const isVideo = m.assets[g.ai]!.type === 'video'
      if (isVideo && !g.items[0]!.key) throw new Error(`video asset ${g.ai}: chunk ${ci} must start with a key frame`)
      const gh: number[] = []
      varint(gh, g.ai)
      varint(gh, g.items.length)
      parts.push(gh)
      for (const it of g.items) {
        const ih: number[] = []
        varint(ih, it.tick)
        if (isVideo) ih.push(it.key ? 1 : 0)
        varint(ih, it.data.length)
        parts.push(ih, it.data)
      }
    }
    const payload = concat(parts)
    varint(table, 1)
    varint(table, ticks(c.start))
    varint(table, ticks(c.end))
    varint(table, deps.length)
    for (const d of deps) varint(table, d)
    varint(table, payload.length)
    payloads.push(payload)
    entryCount++
  })
  m.assets.forEach((a, i) => {
    if (isGlobal(a) && !emitted.has(i)) emitAsset(i)
  })
  const prefix: number[] = [...MAGIC, VERSION]
  varint(prefix, headerBytes.length)
  const tableHead: number[] = []
  varint(tableHead, entryCount)
  const tableBytes = concat([tableHead, table])
  const tableLen: number[] = []
  varint(tableLen, tableBytes.length)
  return concat([prefix, headerBytes, tableLen, tableBytes, ...payloads])
}


class SceneReader {
  private timings = new Recent<Timing>()
  private numbers = new Map<string, Recent<Track<number>>>()
  private paths = new Recent<Track<Path>>()
  private colors: Color[] = []
  private coord: number

  constructor(
    readonly r: BitReader,
    private timescale: number,
    precision: number,
    private assets: Asset[] = [],
  ) {
    this.coord = 2 ** precision
  }

  dq(v: number, step: number | 'coord'): number {
    return v * (step === 'coord' ? this.coord : step)
  }

  time(ticks: number): number {
    return ticks / this.timescale
  }

  chunk(start: number, end: number): ChunkScene {
    const { r } = this
    const defCount = r.count('defs')
    const defs: SceneNode[] = []
    for (let i = 0; i < defCount; i++) defs.push(this.node(i))
    const count = r.count('nodes')
    const nodes: SceneNode[] = []
    for (let i = 0; i < count; i++) nodes.push(this.node(defCount))
    return { start, end, defs, nodes }
  }

  string(key: string): string {
    const n = this.r.count(`${key}.n`, 1 << 20)
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i++) bytes[i] = this.r.symbol(key, 8)
    return new TextDecoder().decode(bytes)
  }

  font(): FontAsset {
    const { r } = this
    const unitsPerEm = r.uint('font.upm')
    const ascent = r.sint('font.asc')
    const descent = r.sint('font.desc')
    const n = r.count('font.n', 1 << 16)
    const glyphs: FontAsset['glyphs'] = []
    let cp = 0
    for (let i = 0; i < n; i++) {
      cp += r.uint('font.cp')
      if (cp > 0x10ffff) throw new Error('corrupt SVV data: bad code point')
      const advance = r.uint('font.adv')
      const topo = this.topology()
      glyphs.push({ char: String.fromCodePoint(cp), advance, path: this.pathFrom(topo, this.geometry(topo)) })
    }
    const k = r.count('font.kern')
    const font: FontAsset = { type: 'font', unitsPerEm, ascent, descent, glyphs }
    if (k) {
      font.kerning = []
      for (let i = 0; i < k; i++) {
        const a = glyphs[r.uint('kern.a')]
        const b = glyphs[r.uint('kern.b')]
        if (!a || !b) throw new Error('corrupt SVV data: bad kerning pair')
        font.kerning.push([a.char, b.char, r.sint('kern.v')])
      }
    }
    return font
  }

  assetRef(key: string, type: Asset['type']): number {
    const i = this.r.uint(key)
    if (this.assets[i]?.type !== type) throw new Error(`corrupt SVV data: ${key} is not a ${type}`)
    return i
  }

  fillStroke(target: { fill?: Paint; stroke?: Stroke }) {
    const { r } = this
    if (r.bit('shape.fill')) target.fill = this.paint()
    if (r.bit('shape.stroke')) {
      const paint = this.paint()
      const width = this.numberTrack(PROP.strokeWidth)
      const join = JOINS[r.symbol('stroke.join', 2)] ?? 'miter'
      const cap = CAPS[r.symbol('stroke.cap', 2)] ?? 'butt'
      target.stroke = { paint, width, join, cap }
    }
  }

  effects(target: Partial<SceneNode>, defCount: number) {
    const { r } = this
    if (r.bit('fx.blend')) {
      const mode = BLEND_MODES[r.symbol('fx.mode', 5)]
      if (!mode) throw new Error('corrupt SVV data: bad blend mode')
      target.blend = mode
    }
    if (r.bit('fx.isolate')) target.isolate = true
    const n = r.count('fx.filters', 64)
    const filters: Filter[] = []
    for (let i = 0; i < n; i++) {
      const type = FILTER_TYPES[r.symbol('filter', 2)]
      if (!type) throw new Error('corrupt SVV data: bad filter')
      if (type === 'blur') filters.push({ type, radius: this.numberTrack(PROP.radius) })
      else if (type === 'shadow') {
        const dx = this.numberTrack(PROP.dx)
        const dy = this.numberTrack(PROP.dy)
        const radius = this.numberTrack(PROP.radius)
        filters.push({ type, dx, dy, radius, color: this.colorTrack() })
      } else {
        const radius = this.numberTrack(PROP.radius)
        const f: Filter = { type, radius, color: this.colorTrack() }
        if (r.bit('glow.k')) f.strength = this.numberTrack(PROP.strength)
        filters.push(f)
      }
    }
    if (filters.length) target.filters = filters
    if (r.bit('fx.mask')) {
      const invert = r.bit('mask.invert')
      const mask: Mask = { node: this.node(defCount) }
      if (invert) mask.invert = true
      target.mask = mask
    }
  }

  color(): Color {
    const { r } = this
    const idx = r.uint('color.idx')
    let c: Color
    if (idx > 0) {
      c = this.colors[idx - 1]!
      if (!c) throw new Error('corrupt color index')
      this.colors.splice(idx - 1, 1)
    } else {
      c = [r.symbol('color.r', 8), r.symbol('color.g', 8), r.symbol('color.b', 8), r.symbol('color.a', 8)]
    }
    this.colors.unshift(c)
    if (this.colors.length > COLOR_CACHE) this.colors.pop()
    return [...c] as Color
  }

  timing(): Timing {
    const { r } = this
    const ref = r.uint('kf.ref')
    if (ref > 0) return this.timings.take(ref - 1)
    const n = r.count('kf.n') + 1
    const t = new Timing()
    t.times.push(r.uint('kf.t0'))
    const mode = n >= 4 && r.bit('kf.mode') ? 1 : 0
    const dts: number[] = []
    for (let i = 0; i < n - 1; i++) {
      const dt = mode === 1 && i >= 2 ? predictDt(1, i, dts) + r.sint('kf.ddt') : r.uint('kf.dt')
      if (dt < 0) throw new Error('corrupt SVV data: negative time step')
      dts.push(dt)
      t.times.push(t.times[i]! + dt)
    }
    let prev = 0
    for (let i = 0; i < n - 1; i++) {
      const s = r.symbol(`ease.${prev}`, 3)
      if (s === CUSTOM_EASE) {
        const x1 = r.symbol('ease.x', 8) / 255
        const y1 = r.sint('ease.y') / 255
        const x2 = r.symbol('ease.x', 8) / 255
        const y2 = r.sint('ease.y') / 255
        t.eases.push([x1, y1, x2, y2])
      } else t.eases.push(EASES[s]!)
      prev = s
    }
    this.timings.add('', t)
    return t
  }

  keyframes<T>(t: Timing, values: T[]): Keyframe<T>[] {
    return values.map((v, i) => {
      const k: Keyframe<T> = { t: this.time(t.times[i]!), v }
      if (i < t.eases.length && t.eases[i] !== 'linear') k.ease = t.eases[i]!
      return k
    })
  }

  numberTrack(prop: NumberProp): Track<number> {
    const { r } = this
    const anim = r.bit(`${prop.key}.anim`)
    const base = Math.round(prop.def / (prop.step === 'coord' ? this.coord : prop.step))
    if (!anim) return this.dq(r.sint(`${prop.key}.v`) + base, prop.step)
    let recent = this.numbers.get(prop.key)
    if (!recent) this.numbers.set(prop.key, (recent = new Recent()))
    const ref = r.uint(`${prop.key}.ref`)
    if (ref > 0) return recent.take(ref - 1)
    const t = this.timing()
    const mode = t.times.length >= 3 ? r.symbol('num.pred', 2) : 0
    if (mode === 3) throw new Error('corrupt SVV data: bad predictor')
    const values: number[] = []
    for (let i = 0; i < t.times.length; i++) {
      values.push(predictValue(mode, i, values, base) + r.sint(i >= 2 && mode ? `${prop.key}.p${mode}` : `${prop.key}.d`))
    }
    const track = this.keyframes(
      t,
      values.map(v => this.dq(v, prop.step)),
    )
    recent.add('', track)
    return track
  }

  colorTrack(): Track<Color> {
    if (!this.r.bit('color.anim')) return this.color()
    const t = this.timing()
    const values: Color[] = [this.color()]
    for (let i = 1; i < t.times.length; i++) {
      const prev = values[i - 1]!
      values.push(prev.map(v => v + this.r.sint('color.d')) as Color)
    }
    return this.keyframes(t, values)
  }

  stops(): GradientStop[] {
    const n = this.r.count('grad.n') + 1
    const out: GradientStop[] = []
    for (let i = 0; i < n; i++) out.push({ offset: this.r.symbol('grad.off', 8) / 255, color: this.color() })
    return out
  }

  paint(): Paint {
    const { r } = this
    const type = r.symbol('paint', 2)
    if (type === 0) return { type: 'solid', color: this.colorTrack() }
    const p = () => this.dq(r.sint('grad.p'), 'coord')
    if (type === 1) {
      const from: [number, number] = [p(), p()]
      const to: [number, number] = [p(), p()]
      return { type: 'linear', from, to, stops: this.stops() }
    }
    const center: [number, number] = [p(), p()]
    const radius = this.dq(r.uint('grad.r'), 'coord')
    return { type: 'radial', center, radius, stops: this.stops() }
  }

  topology(): Topology {
    const { r } = this
    const n = r.count('path.subs')
    const subpaths: Topology['subpaths'] = []
    for (let i = 0; i < n; i++) {
      const segs = r.count('path.segs')
      const closed = r.bit('path.closed')
      const cubic: boolean[] = []
      let prev = 0
      if (r.bit('path.spline')) {
        const corners: boolean[] = []
        for (let j = 0; j <= segs; j++) {
          const c = r.bit(`path.corner.${prev}`)
          corners.push(c)
          prev = c ? 1 : 0
        }
        subpaths.push({ closed, cubic: new Array(segs).fill(false), spline: true, corners })
        continue
      }
      for (let j = 0; j < segs; j++) {
        const c = r.bit(`path.cubic.${prev}`)
        cubic.push(c)
        prev = c ? 1 : 0
      }
      subpaths.push({ closed, cubic })
    }
    return { subpaths }
  }

  geometry(t: Topology): number[] {
    const { r } = this
    const out: number[] = []
    let cx = 0
    let cy = 0
    for (const sp of t.subpaths) {
      cx += r.sint('path.mx')
      cy += r.sint('path.my')
      out.push(cx, cy)
      let pc2x = NaN
      let pc2y = NaN
      if (sp.spline) {
        for (let k = 0; k < sp.cubic.length; k++) {
          cx += r.sint('path.px')
          cy += r.sint('path.py')
          out.push(cx, cy)
        }
        continue
      }
      for (const cubic of sp.cubic) {
        if (!cubic) {
          cx += r.sint('path.lx')
          cy += r.sint('path.ly')
          out.push(cx, cy)
          pc2x = NaN
          continue
        }
        const x = cx + r.sint('path.cx')
        const y = cy + r.sint('path.cy')
        const [p1x, p1y] = predictC1(cx, cy, x, y, pc2x, pc2y)
        const smooth = !Number.isNaN(pc2x)
        const c1x = p1x + r.sint(smooth ? 'path.s1x' : 'path.c1x')
        const c1y = p1y + r.sint(smooth ? 'path.s1y' : 'path.c1y')
        const c2x = Math.round(x + (cx - x) / 3) + r.sint('path.c2x')
        const c2y = Math.round(y + (cy - y) / 3) + r.sint('path.c2y')
        out.push(c1x, c1y, c2x, c2y, x, y)
        cx = x
        cy = y
        pc2x = c2x
        pc2y = c2y
      }
    }
    return out
  }

  pathFrom(t: Topology, coords: number[]): Path {
    return unflattenPath(t, coords.map(v => this.dq(v, 'coord')))
  }

  pathTrack(): Track<Path> {
    const { r } = this
    const ref = r.uint('path.ref')
    if (ref > 0) return this.paths.take(ref - 1)
    const anim = r.bit('path.anim')
    const timing = anim ? this.timing() : null
    const topo = this.topology()
    const flat: number[][] = [this.geometry(topo)]
    for (let k = 1; k < (timing?.times.length ?? 1); k++) {
      const pred = r.symbol('path.pred', 2)
      const prev = flat[k - 1]!
      const prev2 = k > 1 ? flat[k - 2]! : null
      if ((pred === 1 || pred === 3) && !prev2) throw new Error('corrupt SVV data: bad predictor')
      const exact = r.bit('path.exact')
      const cur: number[] = new Array(prev.length)
      for (let i = 0; i < prev.length; i++) cur[i] = predict(pred, i, cur, prev, prev2) + (exact ? 0 : r.sint(`path.r${pred}`))
      flat.push(cur)
    }
    const track: Track<Path> = timing
      ? this.keyframes(
          timing,
          flat.map(c => this.pathFrom(topo, c)),
        )
      : this.pathFrom(topo, flat[0]!)
    this.paths.add('', track)
    return track
  }

  transform(): Transform | undefined {
    const { r } = this
    if (!r.bit('xf')) return undefined
    const t: Transform = {}
    for (const k of XF_KEYS) {
      if (k === 'scaleY' && r.bit('xf.uniform')) {
        if (t.scaleX !== undefined) t.scaleY = t.scaleX
        continue
      }
      if (r.bit(`xf.${k}`)) t[k] = this.numberTrack(PROP[k])
    }
    if (r.bit('xf.anchor')) t.anchor = [this.dq(r.sint('xf.ax'), 'coord'), this.dq(r.sint('xf.ay'), 'coord')]
    return t
  }

  node(defCount: number): SceneNode {
    const { r } = this
    const type = NODE_TYPES[r.symbol('node', 3)]
    if (!type) throw new Error('corrupt node type')
    const start = r.bit('node.start') ? this.time(r.uint('node.t')) : undefined
    const end = r.bit('node.end') ? (start ?? 0) + this.time(r.uint('node.t')) : undefined
    const opacity = r.bit('node.op') ? this.numberTrack(PROP.opacity) : undefined
    const transform = this.transform()
    const fx: Partial<SceneNode> = {}
    if (r.bit('node.fx')) this.effects(fx, defCount)
    let node: SceneNode
    switch (type) {
      case 'group': {
        const n = r.count('group.n')
        const children: SceneNode[] = []
        for (let i = 0; i < n; i++) children.push(this.node(defCount))
        node = { type, children }
        break
      }
      case 'use': {
        const ref = r.uint('use.ref')
        if (ref >= defCount) throw new Error('corrupt use reference')
        node = { type, ref }
        break
      }
      case 'shape': {
        const evenodd = r.bit('shape.evenodd')
        const shape: SceneNode = { type, path: this.pathTrack() }
        if (evenodd) shape.fillRule = 'evenodd'
        this.fillStroke(shape)
        node = shape
        break
      }
      case 'text': {
        const font = this.assetRef('text.font', 'font')
        const text = this.string('text.s')
        const size = this.numberTrack(PROP.fontSize)
        const align = ALIGNS[r.symbol('text.align', 2)]
        if (!align) throw new Error('corrupt SVV data: bad text align')
        const t: SceneNode = { type, font, text, size }
        if (align !== 'left') t.align = align
        if (r.bit('text.ls')) t.letterSpacing = this.dq(r.sint('text.lsv'), 'coord')
        if (r.bit('text.lh')) t.lineHeight = r.uint('text.lhv') / 256
        this.fillStroke(t)
        node = t
        break
      }
      case 'image':
      case 'video': {
        const asset = this.assetRef('media.asset', type)
        const x = this.dq(r.sint('media.x'), 'coord')
        const y = this.dq(r.sint('media.y'), 'coord')
        const width = this.dq(r.uint('media.w'), 'coord')
        const height = this.dq(r.uint('media.h'), 'coord')
        const m: ImageNode | VideoNode = { type, asset, width, height }
        if (x) m.x = x
        if (y) m.y = y
        node = m
        break
      }
    }
    if (start !== undefined) node.start = start
    if (end !== undefined) node.end = end
    if (opacity !== undefined) node.opacity = opacity
    if (transform) node.transform = transform
    Object.assign(node, fx)
    return node
  }
}

export class NeedMoreData extends Error {
  constructor(readonly needed: number) {
    super(`need ${needed} bytes`)
  }
}

export type IndexEntry =
  | { kind: 'asset'; asset: number; offset: number; length: number }
  | { kind: 'chunk'; chunk: number; start: number; end: number; deps: number[]; offset: number; length: number }

export interface MovieIndex {
  movie: Movie
  entries: IndexEntry[]
  chunks: Extract<IndexEntry, { kind: 'chunk' }>[]
  size: number
}

class ByteCursor {
  constructor(
    readonly bytes: Uint8Array,
    public pos: number,
  ) {}

  varint(): number {
    let v = 0
    let scale = 1
    for (let i = 0; i < 8; i++) {
      if (this.pos >= this.bytes.length) throw new NeedMoreData(this.pos + 1)
      const b = this.bytes[this.pos++]!
      v += (b & 0x7f) * scale
      if (b < 0x80) return v
      scale *= 0x80
    }
    throw new Error('corrupt SVV data: varint too long')
  }

  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new NeedMoreData(this.pos + n)
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

export function readIndex(bytes: Uint8Array): MovieIndex {
  if (bytes.length < 4) throw new NeedMoreData(4)
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1] || bytes[2] !== MAGIC[2]) throw new Error('not an SVV file')
  if (bytes[3] !== VERSION) throw new Error(`unsupported SVV version ${bytes[3]}`)
  const cur = new ByteCursor(bytes, 4)
  const headerBytes = cur.take(cur.varint())
  const r = new BitReader(headerBytes)
  const timescale = r.uint('timescale')
  if (timescale === 0) throw new Error('corrupt timescale')
  const precision = r.sint('precision')
  if (precision < -60 || precision > 60) throw new Error('corrupt SVV data: bad precision')
  const hr = new SceneReader(r, timescale, precision)
  const width = hr.dq(r.uint('dim'), 'coord')
  const height = hr.dq(r.uint('dim'), 'coord')
  const duration = hr.time(r.uint('dur'))
  const loop = r.bit('loop')
  const background = r.bit('bg') ? hr.color() : undefined
  const audioRef = r.uint('audio')
  const assetCount = r.count('assets', 1 << 16)
  const assets: Asset[] = []
  for (let i = 0; i < assetCount; i++) {
    const type = ASSET_TYPES[r.symbol('asset', 2)]!
    if (type === 'font') assets.push({ type, unitsPerEm: 1000, ascent: 0, descent: 0, glyphs: [] })
    else if (type === 'image') {
      const mime = IMAGE_MIMES[r.symbol('img.mime', 2)]!
      assets.push({ type, mime, width: r.uint('img.w'), height: r.uint('img.h'), data: new Uint8Array() })
    } else if (type === 'video') {
      const codec = hr.string('codec')
      assets.push({ type, codec, width: r.uint('vid.w'), height: r.uint('vid.h'), frames: [] })
    } else {
      const codec = hr.string('codec')
      assets.push({ type, codec, sampleRate: r.uint('aud.rate'), channels: r.uint('aud.ch'), segments: [] })
    }
  }
  const movie: Movie = { width, height, duration, loop, timescale, precision, assets, chunks: [] }
  if (background) movie.background = background
  if (audioRef > 0) {
    if (assets[audioRef - 1]?.type !== 'audio') throw new Error('corrupt SVV data: bad audio reference')
    movie.audio = audioRef - 1
  }
  const table = new ByteCursor(cur.take(cur.varint()), 0)
  const count = table.varint()
  const entries: IndexEntry[] = []
  const chunks: MovieIndex['chunks'] = []
  let offset = cur.pos
  for (let i = 0; i < count; i++) {
    const kind = table.varint()
    if (kind === 0) {
      const asset = table.varint()
      if (!isGlobal(assets[asset])) throw new Error('corrupt SVV data: bad asset entry')
      const length = table.varint()
      entries.push({ kind: 'asset', asset, offset, length })
      offset += length
    } else if (kind === 1) {
      const start = table.varint() / timescale
      const end = table.varint() / timescale
      const deps: number[] = []
      const nd = table.varint()
      for (let d = 0; d < nd; d++) deps.push(table.varint())
      const length = table.varint()
      const e = { kind: 'chunk' as const, chunk: chunks.length, start, end, deps, offset, length }
      entries.push(e)
      chunks.push(e)
      offset += length
    } else throw new Error('corrupt SVV data: bad entry kind')
  }
  return { movie, entries, chunks, size: offset }
}

export function readAsset(index: MovieIndex, asset: number, payload: Uint8Array): Asset {
  const a = index.movie.assets[asset]!
  if (a.type === 'image') return { ...a, data: payload.slice() }
  if (a.type === 'font') return new SceneReader(new BitReader(payload), index.movie.timescale, 0, index.movie.assets).font()
  throw new Error(`asset ${asset} has no payload`)
}

export interface ChunkMedia {
  asset: number
  frames?: VideoFrame[]
  segments?: AudioSegment[]
}

export function readChunk(index: MovieIndex, chunk: number, payload: Uint8Array): { scene: ChunkScene; media: ChunkMedia[] } {
  const { movie } = index
  const e = index.chunks[chunk]!
  const cur = new ByteCursor(payload, 0)
  const sceneBytes = cur.take(cur.varint())
  const r = new BitReader(sceneBytes)
  const scene = new SceneReader(r, movie.timescale, movie.precision, movie.assets).chunk(e.start, e.end)
  const media: ChunkMedia[] = []
  const groups = cur.varint()
  for (let g = 0; g < groups; g++) {
    const asset = cur.varint()
    const a = movie.assets[asset]
    if (a?.type !== 'video' && a?.type !== 'audio') throw new Error('corrupt SVV data: bad media asset')
    const n = cur.varint()
    const items: { t: number; key: boolean; data: Uint8Array }[] = []
    for (let i = 0; i < n; i++) {
      const t = cur.varint() / movie.timescale
      const key = a.type === 'video' ? cur.take(1)[0] === 1 : false
      items.push({ t, key, data: cur.take(cur.varint()).slice() })
    }
    media.push(a.type === 'video' ? { asset, frames: items } : { asset, segments: items.map(({ t, data }) => ({ t, data })) })
  }
  return { scene, media }
}

export function decode(bytes: Uint8Array): Movie {
  let index: MovieIndex
  try {
    index = readIndex(bytes)
  } catch (e) {
    if (e instanceof NeedMoreData) throw new Error('truncated SVV file')
    throw e
  }
  if (index.size > bytes.length) throw new Error('truncated SVV file')
  const { movie } = index
  const assets: Asset[] = movie.assets.map(a => (a.type === 'video' ? { ...a, frames: [] } : a.type === 'audio' ? { ...a, segments: [] } : a))
  const full: Movie = { ...movie, assets, chunks: [] }
  for (const e of index.entries) {
    const payload = bytes.subarray(e.offset, e.offset + e.length)
    if (e.kind === 'asset') assets[e.asset] = readAsset(index, e.asset, payload)
    else {
      const c = readChunk(index, e.chunk, payload)
      full.chunks.push(c.scene)
      for (const m of c.media) {
        const a = assets[m.asset]!
        if (a.type === 'video') a.frames.push(...m.frames!)
        if (a.type === 'audio') a.segments.push(...m.segments!)
      }
    }
  }
  return full
}

function shiftRefs(n: SceneNode, offset: number) {
  if (n.type === 'use') n.ref += offset
  if (n.type === 'group') n.children.forEach(c => shiftRefs(c, offset))
  if (n.mask) shiftRefs(n.mask.node, offset)
}

export function toScene(movie: Movie): Scene {
  const defs: SceneNode[] = []
  const nodes: SceneNode[] = []
  movie.chunks.forEach((c, i) => {
    const offset = defs.length
    const cd = structuredClone(c.defs)
    const cn = structuredClone(c.nodes)
    for (const d of cd) shiftRefs(d, offset)
    for (const n of cn) shiftRefs(n, offset)
    defs.push(...cd)
    const g: SceneNode = { type: 'group', children: cn }
    if (i > 0) g.start = c.start
    if (i < movie.chunks.length - 1) g.end = c.end
    nodes.push(g)
  })
  const scene: Scene = { width: movie.width, height: movie.height, duration: movie.duration, loop: movie.loop, nodes }
  if (movie.background) scene.background = movie.background
  if (movie.assets.length) scene.assets = movie.assets
  if (movie.audio !== undefined) scene.audio = movie.audio
  if (defs.length) scene.defs = defs
  return scene
}
