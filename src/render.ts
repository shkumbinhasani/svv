import { multiply, type CompiledScene, type LayerItem, type Matrix, type PathItem, type RenderItem, type ResolvedPaint } from './evaluate.ts'
import type { Color } from './model.ts'
import { splineSegments } from './path.ts'

interface GradientLike {
  addColorStop(offset: number, color: string): void
}

interface ImageDataLike {
  data: Uint8ClampedArray
  width: number
  height: number
}

export interface Context2D {
  save(): void
  restore(): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void
  closePath(): void
  fill(rule?: 'nonzero' | 'evenodd'): void
  stroke(): void
  drawImage(image: unknown, x: number, y: number, w?: number, h?: number): void
  drawImage(image: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GradientLike
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GradientLike
  getImageData(x: number, y: number, w: number, h: number): ImageDataLike
  putImageData(data: ImageDataLike, x: number, y: number): void
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  globalCompositeOperation: string
  lineWidth: number
  lineJoin: string
  lineCap: string
  filter?: string
}

export interface Surface {
  canvas: unknown
  ctx: Context2D
}

export interface RenderEnv {
  surface(width: number, height: number): Surface
  release?(surface: Surface): void
  image?(asset: number): unknown
  videoFrame?(asset: number, time: number): unknown
}

export type View = [number, number, number, number]

export interface RenderOptions {
  width: number
  height: number
  view?: View
}

export function cssColor(c: Color): string {
  return `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${(c[3] / 255).toFixed(4)})`
}

function style(ctx: Context2D, p: ResolvedPaint): unknown {
  if (p.type === 'solid') return cssColor(p.color)
  const g =
    p.type === 'linear'
      ? ctx.createLinearGradient(p.from[0], p.from[1], p.to[0], p.to[1])
      : ctx.createRadialGradient(p.center[0], p.center[1], 0, p.center[0], p.center[1], p.radius)
  for (const s of p.stops) g.addColorStop(s.offset, cssColor(s.color))
  return g
}

function tracePath(ctx: Context2D, item: PathItem) {
  const c = item.coords
  let i = 0
  ctx.beginPath()
  for (const sp of item.topology.subpaths) {
    if (sp.spline) {
      const n = sp.cubic.length + 1
      const seg = splineSegments(Array.prototype.slice.call(c, i, i + 2 * n), n, sp.closed, sp.corners)
      ctx.moveTo(c[i]!, c[i + 1]!)
      for (let k = 0; k < seg.length; k += 6) ctx.bezierCurveTo(seg[k]!, seg[k + 1]!, seg[k + 2]!, seg[k + 3]!, seg[k + 4]!, seg[k + 5]!)
      if (sp.closed) ctx.closePath()
      i += 2 * n
      continue
    }
    ctx.moveTo(c[i]!, c[i + 1]!)
    i += 2
    for (const cubic of sp.cubic) {
      if (cubic) {
        ctx.bezierCurveTo(c[i]!, c[i + 1]!, c[i + 2]!, c[i + 3]!, c[i + 4]!, c[i + 5]!)
        i += 6
      } else {
        ctx.lineTo(c[i]!, c[i + 1]!)
        i += 2
      }
    }
    if (sp.closed) ctx.closePath()
  }
}

export function viewMatrix(scene: { width: number; height: number }, opts: RenderOptions): Matrix {
  const [vx, vy, vw, vh] = opts.view ?? [0, 0, scene.width, scene.height]
  const k = Math.min(opts.width / vw, opts.height / vh)
  const ox = (opts.width - vw * k) / 2 - vx * k
  const oy = (opts.height - vh * k) / 2 - vy * k
  return [k, 0, 0, k, ox, oy]
}

const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))

type Rect = [number, number, number, number]

const EMPTY: Rect = [Infinity, Infinity, -Infinity, -Infinity]

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function grow(r: Rect, d: number): Rect {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] + d]
}

function addPoint(r: Rect, m: Matrix, x: number, y: number) {
  const px = m[0] * x + m[2] * y + m[4]
  const py = m[1] * x + m[3] * y + m[5]
  if (px < r[0]) r[0] = px
  if (py < r[1]) r[1] = py
  if (px > r[2]) r[2] = px
  if (py > r[3]) r[3] = py
}

function pathBounds(item: PathItem, m: Matrix): Rect {
  const r: Rect = [...EMPTY]
  const c = item.coords
  let i = 0
  for (const sp of item.topology.subpaths) {
    if (sp.spline) {
      const n = sp.cubic.length + 1
      const seg = splineSegments(Array.prototype.slice.call(c, i, i + 2 * n), n, sp.closed, sp.corners)
      addPoint(r, m, c[i]!, c[i + 1]!)
      for (let k = 0; k < seg.length; k += 2) addPoint(r, m, seg[k]!, seg[k + 1]!)
      i += 2 * n
      continue
    }
    addPoint(r, m, c[i]!, c[i + 1]!)
    i += 2
    for (const cubic of sp.cubic) {
      const end = i + (cubic ? 6 : 2)
      for (; i < end; i += 2) addPoint(r, m, c[i]!, c[i + 1]!)
    }
  }
  const s = item.stroke
  if (!s || s.width <= 0) return r
  return grow(r, (s.width * scaleOf(m) * (s.join === 'miter' ? 10 : 1)) / 2)
}

const BLUR_EXTENT = 3

function itemBounds(item: RenderItem, base: Matrix): Rect {
  const m = multiply(base, item.matrix)
  if (item.kind === 'path') return pathBounds(item, m)
  if (item.kind !== 'layer') {
    const r: Rect = [...EMPTY]
    const [x, y, w, h] = item.rect
    addPoint(r, m, x, y)
    addPoint(r, m, x + w, y)
    addPoint(r, m, x, y + h)
    addPoint(r, m, x + w, y + h)
    return r
  }
  let r = item.items.reduce((acc, i) => union(acc, itemBounds(i, base)), EMPTY)
  if (item.mask && !item.mask.invert) {
    const mb = item.mask.items.reduce((acc, i) => union(acc, itemBounds(i, base)), EMPTY)
    r = [Math.max(r[0], mb[0]), Math.max(r[1], mb[1]), Math.min(r[2], mb[2]), Math.min(r[3], mb[3])]
  }
  const k = scaleOf(m)
  for (const f of item.filters) {
    const spread = grow(r, f.radius * k * BLUR_EXTENT)
    if (f.type === 'shadow') {
      const dx = m[0] * f.dx + m[2] * f.dy
      const dy = m[1] * f.dx + m[3] * f.dy
      r = union(r, [spread[0] + dx, spread[1] + dy, spread[2] + dx, spread[3] + dy])
    } else r = spread
  }
  return r
}

const filterSupport = new WeakMap<object, boolean>()

function supportsFilter(ctx: Context2D): boolean {
  let ok = filterSupport.get(ctx)
  if (ok === undefined) {
    const before = ctx.filter
    try {
      ctx.filter = 'blur(2px)'
      ok = ctx.filter === 'blur(2px)'
    } catch {
      ok = false
    }
    ctx.filter = before ?? 'none'
    filterSupport.set(ctx, ok)
  }
  return ok
}

export function boxBlur(img: ImageDataLike, sigma: number) {
  const { data, width, height } = img
  const n = width * height
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3]! / 255
    ch[0]![i] = data[i * 4]! * a
    ch[1]![i] = data[i * 4 + 1]! * a
    ch[2]![i] = data[i * 4 + 2]! * a
    ch[3]![i] = data[i * 4 + 3]!
  }
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2))
  const tmp = new Float32Array(Math.max(width, height))
  const pass = (buf: Float32Array, len: number, count: number, stride: number, step: number) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride
      let acc = 0
      for (let k = -r; k <= r; k++) acc += buf[base + Math.min(len - 1, Math.max(0, k)) * step]!
      for (let i = 0; i < len; i++) {
        tmp[i] = acc / (2 * r + 1)
        acc += buf[base + Math.min(len - 1, i + r + 1) * step]! - buf[base + Math.max(0, i - r) * step]!
      }
      for (let i = 0; i < len; i++) buf[base + i * step] = tmp[i]!
    }
  }
  for (const buf of ch) {
    for (let k = 0; k < 3; k++) {
      pass(buf, width, height, width, 1)
      pass(buf, height, width, 1, width)
    }
  }
  for (let i = 0; i < n; i++) {
    const a = ch[3]![i]!
    const inv = a > 0 ? 255 / a : 0
    data[i * 4] = ch[0]![i]! * inv
    data[i * 4 + 1] = ch[1]![i]! * inv
    data[i * 4 + 2] = ch[2]![i]! * inv
    data[i * 4 + 3] = a
  }
}

export class Renderer {
  constructor(
    readonly env: RenderEnv,
    readonly width: number,
    readonly height: number,
  ) {}

  private surface(r: Rect): Surface {
    const s = this.env.surface(this.width, this.height)
    s.ctx.setTransform(1, 0, 0, 1, 0, 0)
    s.ctx.globalAlpha = 1
    s.ctx.globalCompositeOperation = 'source-over'
    if (s.ctx.filter !== undefined) s.ctx.filter = 'none'
    s.ctx.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1])
    return s
  }

  private release(s: Surface) {
    this.env.release?.(s)
  }

  private blurred(src: Surface, px: number, r: Rect): Surface {
    const [x, y, w, h] = [r[0], r[1], r[2] - r[0], r[3] - r[1]]
    const out = this.surface(r)
    if (px <= 0.05) {
      out.ctx.drawImage(src.canvas, x, y, w, h, x, y, w, h)
      return out
    }
    if (supportsFilter(out.ctx)) {
      out.ctx.filter = `blur(${px}px)`
      out.ctx.drawImage(src.canvas, x, y, w, h, x, y, w, h)
      out.ctx.filter = 'none'
      return out
    }
    const img = src.ctx.getImageData(x, y, w, h)
    boxBlur(img, px)
    out.ctx.putImageData(img, x, y)
    return out
  }

  private tinted(src: Surface, px: number, color: Color, r: Rect): Surface {
    const s = this.blurred(src, px, r)
    s.ctx.globalCompositeOperation = 'source-in'
    s.ctx.fillStyle = cssColor(color)
    s.ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1])
    s.ctx.globalCompositeOperation = 'source-over'
    return s
  }

  private layer(ctx: Context2D, item: LayerItem, base: Matrix) {
    const b = itemBounds(item, base)
    const r: Rect = [Math.max(0, Math.floor(b[0])), Math.max(0, Math.floor(b[1])), Math.min(this.width, Math.ceil(b[2])), Math.min(this.height, Math.ceil(b[3]))]
    if (r[2] <= r[0] || r[3] <= r[1]) return
    const [x, y, w, h] = [r[0], r[1], r[2] - r[0], r[3] - r[1]]
    let content = this.surface(r)
    this.items(content.ctx, item.items, base)
    if (item.mask) {
      const m = this.surface(r)
      this.items(m.ctx, item.mask.items, base)
      content.ctx.setTransform(1, 0, 0, 1, 0, 0)
      content.ctx.globalAlpha = 1
      content.ctx.globalCompositeOperation = item.mask.invert ? 'destination-out' : 'destination-in'
      content.ctx.drawImage(m.canvas, x, y, w, h, x, y, w, h)
      content.ctx.globalCompositeOperation = 'source-over'
      this.release(m)
    }
    const k = scaleOf(multiply(base, item.matrix))
    for (const f of item.filters) {
      if (f.type === 'blur') {
        const next = this.blurred(content, f.radius * k, r)
        this.release(content)
        content = next
        continue
      }
      const under = this.tinted(content, f.radius * k, f.color, r)
      const out = this.surface(r)
      if (f.type === 'glow') {
        let s = f.strength
        while (s > 0) {
          out.ctx.globalAlpha = Math.min(1, s)
          out.ctx.drawImage(under.canvas, x, y, w, h, x, y, w, h)
          s -= 1
        }
        out.ctx.globalAlpha = 1
      } else {
        const m = multiply(base, item.matrix)
        out.ctx.drawImage(under.canvas, x, y, w, h, x + m[0] * f.dx + m[2] * f.dy, y + m[1] * f.dx + m[3] * f.dy, w, h)
      }
      out.ctx.drawImage(content.canvas, x, y, w, h, x, y, w, h)
      this.release(under)
      this.release(content)
      content = out
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = Math.min(1, item.opacity)
    ctx.globalCompositeOperation = item.blend
    ctx.drawImage(content.canvas, x, y, w, h, x, y, w, h)
    ctx.globalCompositeOperation = 'source-over'
    this.release(content)
  }

  items(ctx: Context2D, items: RenderItem[], base: Matrix) {
    for (const item of items) {
      if (item.kind === 'layer') {
        this.layer(ctx, item, base)
        continue
      }
      const m = multiply(base, item.matrix)
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
      ctx.globalAlpha = Math.min(1, item.opacity)
      ctx.globalCompositeOperation = item.blend
      if (item.kind === 'path') {
        tracePath(ctx, item)
        if (item.fill) {
          ctx.fillStyle = style(ctx, item.fill)
          ctx.fill(item.fillRule)
        }
        if (item.stroke && item.stroke.width > 0) {
          ctx.strokeStyle = style(ctx, item.stroke.paint)
          ctx.lineWidth = item.stroke.width
          ctx.lineJoin = item.stroke.join
          ctx.lineCap = item.stroke.cap
          ctx.stroke()
        }
      } else {
        const src = item.kind === 'image' ? this.env.image?.(item.asset) : this.env.videoFrame?.(item.asset, item.time)
        if (src) ctx.drawImage(src, item.rect[0], item.rect[1], item.rect[2], item.rect[3])
      }
    }
    ctx.globalCompositeOperation = 'source-over'
  }

  frame(ctx: Context2D, compiled: CompiledScene, time: number, view?: View) {
    const { scene } = compiled
    const base = viewMatrix(scene, { width: this.width, height: this.height, view })
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, this.width, this.height)
    if (scene.background) {
      ctx.fillStyle = cssColor(scene.background)
      ctx.fillRect(0, 0, this.width, this.height)
    }
    this.items(ctx, compiled.sample(time), base)
    ctx.restore()
  }
}

export function drawFrame(ctx: Context2D, compiled: CompiledScene, time: number, opts: RenderOptions & { env?: RenderEnv }): void {
  const env = opts.env ?? {
    surface() {
      throw new Error('this scene needs layers; pass a RenderEnv with a surface factory')
    },
  }
  new Renderer(env, opts.width, opts.height).frame(ctx, compiled, time, opts.view)
}
