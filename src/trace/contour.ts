import type { Path, Subpath, Vec } from '../model.ts'
import type { Regions } from './segment.ts'

export interface TracedLoop {
  dense: Vec[]
  points: Vec[]
  corners: boolean[]
}

export interface TracedShape {
  loops: TracedLoop[]
  color: number
  area: number
  x0: number
  y0: number
  w: number
  h: number
  mask: Uint8Array
  path: Path
}

export interface ContourOptions {
  tolerance: number
  minHole: number
  cornerAngle: number
}

function loops(mask: Uint8Array, w: number, h: number): Vec[][] {
  const W = w + 2
  const H = h + 2
  const at = (x: number, y: number) => (x >= 1 && y >= 1 && x <= w && y <= h ? mask[(y - 1) * w + (x - 1)]! : 0)
  const next = new Int32Array(2 * W * H).fill(-1)
  const hid = (x: number, y: number) => 2 * (y * W + x)
  const vid = (x: number, y: number) => 2 * (y * W + x) + 1
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const c = (at(x, y) << 3) | (at(x + 1, y) << 2) | (at(x + 1, y + 1) << 1) | at(x, y + 1)
      if (c === 0 || c === 15) continue
      const T = hid(x, y)
      const B = hid(x, y + 1)
      const L = vid(x, y)
      const R = vid(x + 1, y)
      switch (c) {
        case 1: next[B] = L; break
        case 2: next[R] = B; break
        case 3: next[R] = L; break
        case 4: next[T] = R; break
        case 5: next[B] = L; next[T] = R; break
        case 6: next[T] = B; break
        case 7: next[T] = L; break
        case 8: next[L] = T; break
        case 9: next[B] = T; break
        case 10: next[L] = T; next[R] = B; break
        case 11: next[R] = T; break
        case 12: next[L] = R; break
        case 13: next[B] = R; break
        case 14: next[L] = B; break
      }
    }
  }
  const out: Vec[][] = []
  for (let s = 0; s < next.length; s++) {
    if (next[s] === -1) continue
    const loop: Vec[] = []
    let e = s
    while (next[e] !== -1) {
      const cell = e >> 1
      const x = cell % W
      const y = (cell - x) / W
      loop.push(e & 1 ? [x - 0.5, y] : [x, y - 0.5])
      const n = next[e]!
      next[e] = -1
      e = n
    }
    if (loop.length >= 3) out.push(loop)
  }
  return out
}

function smooth(p: Vec[]): Vec[] {
  const n = p.length
  return p.map((v, i) => {
    const a = p[(i - 1 + n) % n]!
    const b = p[(i + 1) % n]!
    return [(a[0] + 2 * v[0] + b[0]) / 4, (a[1] + 2 * v[1] + b[1]) / 4]
  })
}

function dp(p: Vec[], a: number, b: number, tol: number, keep: Uint8Array) {
  const n = p.length
  const A = p[a]!
  const B = p[b % n]!
  const dx = B[0] - A[0]
  const dy = B[1] - A[1]
  const len = Math.hypot(dx, dy)
  let best = -1
  let bd = tol
  for (let i = a + 1; i < b; i++) {
    const P = p[i % n]!
    const d = len > 1e-9 ? Math.abs((P[0] - A[0]) * dy - (P[1] - A[1]) * dx) / len : Math.hypot(P[0] - A[0], P[1] - A[1])
    if (d > bd) {
      bd = d
      best = i
    }
  }
  if (best < 0) return
  keep[best % n] = 1
  dp(p, a, best, tol, keep)
  dp(p, best, b, tol, keep)
}

function simplify(p: Vec[], tol: number): Vec[] {
  const n = p.length
  let far = 0
  let fd = -1
  for (let i = 1; i < n; i++) {
    const d = (p[i]![0] - p[0]![0]) ** 2 + (p[i]![1] - p[0]![1]) ** 2
    if (d > fd) {
      fd = d
      far = i
    }
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[far] = 1
  dp(p, 0, far, tol, keep)
  dp(p, far, n, tol, keep)
  return p.filter((_, i) => keep[i])
}

const areaOf = (p: Vec[]) => {
  let a = 0
  for (let i = 0; i < p.length; i++) {
    const u = p[i]!
    const v = p[(i + 1) % p.length]!
    a += u[0] * v[1] - v[0] * u[1]
  }
  return a / 2
}

export function maskToLoops(mask: Uint8Array, w: number, h: number, x0: number, y0: number, opts: ContourOptions): TracedLoop[] {
  const cos = Math.cos((opts.cornerAngle * Math.PI) / 180)
  const out: TracedLoop[] = []
  const raw = loops(mask, w, h)
  const outerSign = Math.sign(raw.reduce((best, l) => (Math.abs(areaOf(l)) > Math.abs(best) ? areaOf(l) : best), 0)) || 1
  for (const loop of raw) {
    const a = areaOf(loop)
    if (Math.sign(a) !== outerSign && Math.abs(a) < opts.minHole) continue
    if (Math.abs(a) < 1) continue
    const dense = smooth(loop)
    const pts = simplify(dense, opts.tolerance)
    if (pts.length < 3) continue
    const n = pts.length
    const corners = pts.map((v, i) => {
      const p = pts[(i - 1 + n) % n]!
      const q = pts[(i + 1) % n]!
      const ax = v[0] - p[0]
      const ay = v[1] - p[1]
      const bx = q[0] - v[0]
      const by = q[1] - v[1]
      const d = Math.hypot(ax, ay) * Math.hypot(bx, by)
      return d > 0 && (ax * bx + ay * by) / d < cos
    })
    const shift = (v: Vec): Vec => [v[0] + x0, v[1] + y0]
    out.push({ dense: dense.map(shift), points: pts.map(shift), corners })
  }
  const key = (l: TracedLoop) => l.dense.reduce((m, p) => Math.min(m, p[1] * 100000 + p[0]), Infinity)
  return out.sort((x, y) => key(x) - key(y))
}

export function loopsToPath(loops: { points: Vec[]; corners: boolean[] }[]): Path {
  return loops.map((l): Subpath => ({ start: l.points[0]!, segments: l.points.slice(1).map(to => ({ to })), closed: true, spline: true, corners: l.corners }))
}

export function stackedShapes(R: Regions, opts: ContourOptions): TracedShape[] {
  const { width, height, id } = R
  const n = width * height
  const order = Array.from({ length: R.count }, (_, i) => i).sort((a, b) => R.area[b]! - R.area[a]! || a - b)
  const start = new Int32Array(R.count + 1)
  for (let i = 0; i < n; i++) if (id[i]! >= 0) start[id[i]! + 1]!++
  for (let r = 0; r < R.count; r++) start[r + 1]! += start[r]!
  const pix = new Int32Array(n)
  const fill = start.slice()
  for (let i = 0; i < n; i++) if (id[i]! >= 0) pix[fill[id[i]!]!++] = i
  const parent = new Int32Array(n).fill(-1)
  const minx = new Int32Array(n)
  const miny = new Int32Array(n)
  const maxx = new Int32Array(n)
  const maxy = new Int32Array(n)
  const find = (a: number) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!
    return a
  }
  const union = (a: number, b: number) => {
    a = find(a)
    b = find(b)
    if (a === b) return
    parent[b] = a
    minx[a] = Math.min(minx[a]!, minx[b]!)
    miny[a] = Math.min(miny[a]!, miny[b]!)
    maxx[a] = Math.max(maxx[a]!, maxx[b]!)
    maxy[a] = Math.max(maxy[a]!, maxy[b]!)
  }
  const shapes: TracedShape[] = []
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k]!
    for (let j = start[r]!; j < start[r + 1]!; j++) {
      const p = pix[j]!
      const x = p % width
      const y = (p - x) / width
      parent[p] = p
      minx[p] = maxx[p] = x
      miny[p] = maxy[p] = y
      if (x > 0 && parent[p - 1]! >= 0) union(p - 1, p)
      if (x < width - 1 && parent[p + 1]! >= 0) union(p + 1, p)
      if (y > 0 && parent[p - width]! >= 0) union(p - width, p)
      if (y < height - 1 && parent[p + width]! >= 0) union(p + width, p)
    }
    const root = find(pix[start[r]!]!)
    const x0 = minx[root]!
    const y0 = miny[root]!
    const w = maxx[root]! - x0 + 1
    const h = maxy[root]! - y0 + 1
    const mask = new Uint8Array(w * h)
    let area = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = (y + y0) * width + x + x0
        if (parent[p]! >= 0 && find(p) === root) {
          mask[y * w + x] = 1
          area++
        }
      }
    }
    const loops = maskToLoops(mask, w, h, x0, y0, opts)
    shapes.push({ loops, color: R.color[r]!, area, x0, y0, w, h, mask, path: loopsToPath(loops) })
  }
  return shapes.reverse().filter(s => s.path.length)
}
