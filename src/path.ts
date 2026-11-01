import type { Path, Segment, Subpath, Vec } from './model.ts'

const KAPPA = 0.5522847498307936

export interface TopologySubpath {
  closed: boolean
  cubic: boolean[]
  spline?: boolean
  corners?: boolean[]
}

export interface Topology {
  subpaths: TopologySubpath[]
}

export function splineSegments(points: ArrayLike<number>, count: number, closed: boolean, corners: boolean[] | undefined): number[] {
  const px = (i: number) => points[2 * i]!
  const py = (i: number) => points[2 * i + 1]!
  const idx = (i: number) => (closed ? (i + count) % count : Math.max(0, Math.min(count - 1, i)))
  const out: number[] = []
  const segs = closed ? count : count - 1
  for (let i = 0; i < segs; i++) {
    const a = idx(i)
    const b = idx(i + 1)
    const ca = corners?.[a]
    const cb = corners?.[b]
    const p0 = idx(i - 1)
    const p3 = idx(i + 2)
    out.push(
      ca ? px(a) : px(a) + (px(b) - px(p0)) / 6,
      ca ? py(a) : py(a) + (py(b) - py(p0)) / 6,
      cb ? px(b) : px(b) - (px(p3) - px(a)) / 6,
      cb ? py(b) : py(b) - (py(p3) - py(a)) / 6,
      px(b),
      py(b),
    )
  }
  return out
}

export function expandSpline(sp: Subpath): Subpath {
  if (!sp.spline) return sp
  const pts = [sp.start, ...sp.segments.map(s => s.to)]
  const flat = pts.flat()
  const c = splineSegments(flat, pts.length, sp.closed, sp.corners)
  const segments: Segment[] = []
  for (let i = 0; i < c.length; i += 6) segments.push({ c1: [c[i]!, c[i + 1]!], c2: [c[i + 2]!, c[i + 3]!], to: [c[i + 4]!, c[i + 5]!] })
  return { start: sp.start, segments, closed: sp.closed }
}

export function flattenPath(path: Path): { topology: Topology; coords: number[] } {
  const coords: number[] = []
  const subpaths = path.map((sp): TopologySubpath => {
    coords.push(sp.start[0], sp.start[1])
    if (sp.spline) {
      for (const seg of sp.segments) coords.push(seg.to[0], seg.to[1])
      const corners = Array.from({ length: sp.segments.length + 1 }, (_, i) => !!sp.corners?.[i])
      return { closed: sp.closed, cubic: sp.segments.map(() => false), spline: true, corners }
    }
    const cubic = sp.segments.map(seg => {
      if (seg.c1 && seg.c2) {
        coords.push(seg.c1[0], seg.c1[1], seg.c2[0], seg.c2[1], seg.to[0], seg.to[1])
        return true
      }
      coords.push(seg.to[0], seg.to[1])
      return false
    })
    return { closed: sp.closed, cubic }
  })
  return { topology: { subpaths }, coords }
}

export function unflattenPath(topology: Topology, coords: ArrayLike<number>): Path {
  let i = 0
  const v = (): Vec => {
    const p: Vec = [coords[i]!, coords[i + 1]!]
    i += 2
    return p
  }
  return topology.subpaths.map(sp => {
    const start = v()
    const segments = sp.cubic.map(c => (c ? { c1: v(), c2: v(), to: v() } : { to: v() }))
    const out: Subpath = { start, segments, closed: sp.closed }
    if (sp.spline) {
      out.spline = true
      out.corners = [...(sp.corners ?? [])]
    }
    return out
  })
}

export function sameTopology(a: Topology, b: Topology): boolean {
  if (a.subpaths.length !== b.subpaths.length) return false
  return a.subpaths.every((sp, i) => {
    const o = b.subpaths[i]!
    return (
      sp.closed === o.closed &&
      !!sp.spline === !!o.spline &&
      sp.cubic.length === o.cubic.length &&
      sp.cubic.every((c, j) => c === o.cubic[j]) &&
      (!sp.spline || sp.corners!.every((c, j) => c === o.corners![j]))
    )
  })
}

const lerp = (a: Vec, b: Vec, t: number): Vec => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1])
const same = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1]

function toCubic(from: Vec, seg: Segment): Segment {
  if (seg.c1 && seg.c2) return seg
  return { c1: lerp(from, seg.to, 1 / 3), c2: lerp(from, seg.to, 2 / 3), to: seg.to }
}

function splitSegment(from: Vec, seg: Segment): [Segment, Segment] {
  if (!seg.c1 || !seg.c2) {
    const mid = lerp(from, seg.to, 0.5)
    return [{ to: mid }, { to: seg.to }]
  }
  const ab = lerp(from, seg.c1, 0.5)
  const bc = lerp(seg.c1, seg.c2, 0.5)
  const cd = lerp(seg.c2, seg.to, 0.5)
  const abc = lerp(ab, bc, 0.5)
  const bcd = lerp(bc, cd, 0.5)
  const mid = lerp(abc, bcd, 0.5)
  return [
    { c1: ab, c2: abc, to: mid },
    { c1: bcd, c2: cd, to: seg.to },
  ]
}

function segmentLength(from: Vec, seg: Segment): number {
  if (!seg.c1 || !seg.c2) return dist(from, seg.to)
  return (dist(from, seg.c1) + dist(seg.c1, seg.c2) + dist(seg.c2, seg.to) + dist(from, seg.to)) / 2
}

function subdivideTo(sp: Subpath, count: number): Subpath {
  const segments = [...sp.segments]
  if (segments.length === 0) segments.push({ to: sp.start })
  while (segments.length < count) {
    let best = 0
    let bestLen = -1
    let from = sp.start
    let bestFrom = sp.start
    segments.forEach((seg, i) => {
      const len = segmentLength(from, seg)
      if (len > bestLen) {
        bestLen = len
        best = i
        bestFrom = from
      }
      from = seg.to
    })
    segments.splice(best, 1, ...splitSegment(bestFrom, segments[best]!))
  }
  return { ...sp, segments }
}

function closeExplicitly(sp: Subpath): Subpath {
  if (!sp.closed) return sp
  const last = sp.segments.length ? sp.segments[sp.segments.length - 1]!.to : sp.start
  if (same(last, sp.start)) return sp
  return { ...sp, segments: [...sp.segments, { to: sp.start }] }
}

function rotateClosed(sp: Subpath, k: number): Subpath {
  if (k === 0) return sp
  const n = sp.segments.length
  const segs = [...sp.segments.slice(k), ...sp.segments.slice(0, k)]
  return { start: sp.segments[k - 1]!.to, segments: segs.slice(0, n), closed: true }
}

function bestRotation(ref: Subpath, sp: Subpath): number {
  const n = sp.segments.length
  let best = 0
  let bestCost = Infinity
  for (let k = 0; k < n; k++) {
    let cost = 0
    for (let i = 0; i < n; i++) cost += dist(ref.segments[i]!.to, sp.segments[(i + k) % n]!.to) ** 2
    if (cost < bestCost) {
      bestCost = cost
      best = k
    }
  }
  return best
}

function centroid(path: Path): Vec {
  let x = 0
  let y = 0
  let n = 0
  for (const sp of path) {
    for (const p of [sp.start, ...sp.segments.map(s => s.to)]) {
      x += p[0]
      y += p[1]
      n++
    }
  }
  return n ? [x / n, y / n] : [0, 0]
}

export function unifyPaths(paths: Path[]): Path[] {
  if (paths.length < 2) return paths
  const subCount = Math.max(...paths.map(p => p.length))
  let work = paths.map(p => {
    const out = p.map(expandSpline).map(closeExplicitly)
    const c = centroid(p)
    while (out.length < subCount) out.push({ start: c, segments: [{ to: c }], closed: true })
    return out
  })
  for (let j = 0; j < subCount; j++) {
    const closed = work[0]![j]!.closed
    for (const p of work) p[j] = closeExplicitly({ ...p[j]!, closed })
    const count = Math.max(...work.map(p => Math.max(1, p[j]!.segments.length)))
    for (const p of work) p[j] = subdivideTo(p[j]!, count)
    if (closed) {
      for (let k = 1; k < work.length; k++) {
        const p = work[k]!
        p[j] = rotateClosed(p[j]!, bestRotation(work[k - 1]![j]!, p[j]!))
      }
    }
    for (let i = 0; i < count; i++) {
      if (!work.some(p => p[j]!.segments[i]!.c1)) continue
      for (const p of work) {
        const sp = p[j]!
        const from = i === 0 ? sp.start : sp.segments[i - 1]!.to
        sp.segments[i] = toCubic(from, sp.segments[i]!)
      }
    }
  }
  return work
}

export function transformPath(path: Path, f: (p: Vec) => Vec): Path {
  return path.map(sp => ({
    ...sp,
    start: f(sp.start),
    segments: sp.segments.map(s => (s.c1 && s.c2 ? { c1: f(s.c1), c2: f(s.c2), to: f(s.to) } : { to: f(s.to) })),
  }))
}

export function rect(x: number, y: number, w: number, h: number, r = 0): Path {
  if (r <= 0) {
    return [{ start: [x, y], segments: [{ to: [x + w, y] }, { to: [x + w, y + h] }, { to: [x, y + h] }], closed: true }]
  }
  r = Math.min(r, w / 2, h / 2)
  const k = r * (1 - KAPPA)
  const x2 = x + w
  const y2 = y + h
  return [
    {
      start: [x + r, y],
      closed: true,
      segments: [
        { to: [x2 - r, y] },
        { c1: [x2 - k, y], c2: [x2, y + k], to: [x2, y + r] },
        { to: [x2, y2 - r] },
        { c1: [x2, y2 - k], c2: [x2 - k, y2], to: [x2 - r, y2] },
        { to: [x + r, y2] },
        { c1: [x + k, y2], c2: [x, y2 - k], to: [x, y2 - r] },
        { to: [x, y + r] },
        { c1: [x, y + k], c2: [x + k, y], to: [x + r, y] },
      ],
    },
  ]
}

export function ellipse(cx: number, cy: number, rx: number, ry = rx): Path {
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    {
      start: [cx + rx, cy],
      closed: true,
      segments: [
        { c1: [cx + rx, cy + ky], c2: [cx + kx, cy + ry], to: [cx, cy + ry] },
        { c1: [cx - kx, cy + ry], c2: [cx - rx, cy + ky], to: [cx - rx, cy] },
        { c1: [cx - rx, cy - ky], c2: [cx - kx, cy - ry], to: [cx, cy - ry] },
        { c1: [cx + kx, cy - ry], c2: [cx + rx, cy - ky], to: [cx + rx, cy] },
      ],
    },
  ]
}

export function polygon(points: Vec[], closed = true): Path {
  const [first, ...rest] = points
  if (!first) return []
  return [{ start: first, segments: rest.map(to => ({ to })), closed }]
}

export function regularPolygon(cx: number, cy: number, r: number, sides: number, rotation = -Math.PI / 2): Path {
  const pts: Vec[] = []
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i / sides) * Math.PI * 2
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return polygon(pts)
}

export function star(cx: number, cy: number, outer: number, inner: number, points: number, rotation = -Math.PI / 2): Path {
  const pts: Vec[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = rotation + (i / (points * 2)) * Math.PI * 2
    const r = i % 2 === 0 ? outer : inner
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
  }
  return polygon(pts)
}

export function line(points: Vec[]): Path {
  return polygon(points, false)
}

export function smoothPolyline(points: Vec[], closed = false, tension = 1): Path {
  const n = points.length
  if (n < 3) return polygon(points, closed)
  const at = (i: number) => points[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))]!
  const segments: Segment[] = []
  const count = closed ? n : n - 1
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const t = tension / 6
    segments.push({
      c1: [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t],
      c2: [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t],
      to: p2,
    })
  }
  return [{ start: points[0]!, segments, closed }]
}

function arcToCubics(from: Vec, rx: number, ry: number, phiDeg: number, largeArc: boolean, sweep: boolean, to: Vec): Segment[] {
  if (rx === 0 || ry === 0) return [{ to }]
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (from[0] - to[0]) / 2
  const dy = (from[1] - to[1]) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let coef = Math.sqrt(Math.max(0, num / den))
  if (largeArc === sweep) coef = -coef
  const cxp = (coef * rx * y1) / ry
  const cyp = (-coef * ry * x1) / rx
  const cx = cos * cxp - sin * cyp + (from[0] + to[0]) / 2
  const cy = sin * cxp + cos * cyp + (from[1] + to[1]) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const theta1 = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
  if (!sweep && delta > 0) delta -= Math.PI * 2
  if (sweep && delta < 0) delta += Math.PI * 2
  const parts = Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9)
  const step = delta / parts
  const t = (4 / 3) * Math.tan(step / 4)
  const point = (a: number): Vec => [cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin, cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos]
  const deriv = (a: number): Vec => [-rx * Math.sin(a) * cos - ry * Math.cos(a) * sin, -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos]
  const out: Segment[] = []
  let a = theta1
  for (let i = 0; i < parts; i++) {
    const b = a + step
    const p0 = point(a)
    const p3 = i === parts - 1 ? to : point(b)
    const d0 = deriv(a)
    const d3 = deriv(b)
    out.push({ c1: [p0[0] + d0[0] * t, p0[1] + d0[1] * t], c2: [p3[0] - d3[0] * t, p3[1] - d3[1] * t], to: p3 })
    a = b
  }
  return out
}

export function parseSvgPath(d: string): Path {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []
  let i = 0
  const path: Path = []
  let current: Subpath | null = null
  let cur: Vec = [0, 0]
  let startPt: Vec = [0, 0]
  let lastCtrl: Vec | null = null
  let lastQuad: Vec | null = null
  let cmd = ''
  const num = () => Number(tokens[i++])
  const flag = () => {
    const tok = tokens[i]!
    if (tok.length > 1 && (tok[0] === '0' || tok[0] === '1')) {
      tokens[i] = tok.slice(1)
      return tok[0] === '1'
    }
    i++
    return tok === '1'
  }
  const ensure = () => {
    if (!current) {
      current = { start: cur, segments: [], closed: false }
      path.push(current)
    }
    return current
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!
    const rel = cmd === cmd.toLowerCase()
    const off = (x: number, y: number): Vec => (rel ? [cur[0] + x, cur[1] + y] : [x, y])
    const C = cmd.toUpperCase()
    let ctrl: Vec | null = null
    let quad: Vec | null = null
    switch (C) {
      case 'M': {
        const p = off(num(), num())
        current = { start: p, segments: [], closed: false }
        path.push(current)
        cur = startPt = p
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        const p = off(num(), num())
        ensure().segments.push({ to: p })
        cur = p
        break
      }
      case 'H': {
        const x = num()
        const p: Vec = [rel ? cur[0] + x : x, cur[1]]
        ensure().segments.push({ to: p })
        cur = p
        break
      }
      case 'V': {
        const y = num()
        const p: Vec = [cur[0], rel ? cur[1] + y : y]
        ensure().segments.push({ to: p })
        cur = p
        break
      }
      case 'C': {
        const c1 = off(num(), num())
        const c2 = off(num(), num())
        const p = off(num(), num())
        ensure().segments.push({ c1, c2, to: p })
        cur = p
        ctrl = c2
        break
      }
      case 'S': {
        const c1: Vec = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur
        const c2 = off(num(), num())
        const p = off(num(), num())
        ensure().segments.push({ c1, c2, to: p })
        cur = p
        ctrl = c2
        break
      }
      case 'Q':
      case 'T': {
        const q: Vec = C === 'Q' ? off(num(), num()) : lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur
        const p = off(num(), num())
        ensure().segments.push({ c1: lerp(cur, q, 2 / 3), c2: lerp(p, q, 2 / 3), to: p })
        cur = p
        quad = q
        break
      }
      case 'A': {
        const rx = num()
        const ry = num()
        const rot = num()
        const large = flag()
        const sweep = flag()
        const p = off(num(), num())
        ensure().segments.push(...arcToCubics(cur, rx, ry, rot, large, sweep, p))
        cur = p
        break
      }
      case 'Z': {
        if (current) current.closed = true
        cur = startPt
        current = null
        break
      }
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
    lastCtrl = ctrl
    lastQuad = quad
  }
  return path
}

export function pathToSvg(path: Path, digits = 3): string {
  const f = (n: number) => String(Number(n.toFixed(digits)))
  const p = (v: Vec) => `${f(v[0])} ${f(v[1])}`
  return path
    .map(expandSpline)
    .map(sp => {
      let s = `M${p(sp.start)}`
      for (const seg of sp.segments) s += seg.c1 && seg.c2 ? `C${p(seg.c1)} ${p(seg.c2)} ${p(seg.to)}` : `L${p(seg.to)}`
      return sp.closed ? s + 'Z' : s
    })
    .join('')
}
