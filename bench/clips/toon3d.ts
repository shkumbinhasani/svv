import { writeClip } from './common.ts'

const W = 1280
const H = 720
const fps = 24
const seconds = 5
const SS = 2

type V = [number, number, number]
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: V): V => mul(a, 1 / Math.hypot(a[0], a[1], a[2]))

interface Hit {
  t: number
  n: V
  id: number
}

interface Obj {
  id: number
  colors: [string, string, string]
  hit(o: V, d: V): Hit | null
}

function sphere(id: number, c: V, r: number, colors: [string, string, string]): Obj {
  return {
    id,
    colors,
    hit(o, d) {
      const oc = sub(o, c)
      const b = dot(oc, d)
      const disc = b * b - (dot(oc, oc) - r * r)
      if (disc < 0) return null
      const t = -b - Math.sqrt(disc)
      if (t < 1e-3) return null
      return { t, n: norm(sub(add(o, mul(d, t)), c)), id }
    },
  }
}

function box(id: number, c: V, half: V, angle: number, colors: [string, string, string]): Obj {
  const cs = Math.cos(angle)
  const sn = Math.sin(angle)
  const toLocal = (v: V): V => [v[0] * cs + v[2] * sn, v[1], -v[0] * sn + v[2] * cs]
  const toWorld = (v: V): V => [v[0] * cs - v[2] * sn, v[1], v[0] * sn + v[2] * cs]
  return {
    id,
    colors,
    hit(o, d) {
      const lo = toLocal(sub(o, c))
      const ld = toLocal(d)
      let tmin = -Infinity
      let tmax = Infinity
      let axis = 0
      let sign = 1
      for (let k = 0; k < 3; k++) {
        if (Math.abs(ld[k]!) < 1e-9) {
          if (Math.abs(lo[k]!) > half[k]!) return null
          continue
        }
        let t1 = (-half[k]! - lo[k]!) / ld[k]!
        let t2 = (half[k]! - lo[k]!) / ld[k]!
        let s = -1
        if (t1 > t2) {
          ;[t1, t2] = [t2, t1]
          s = 1
        }
        if (t1 > tmin) {
          tmin = t1
          axis = k
          sign = s
        }
        tmax = Math.min(tmax, t2)
      }
      if (tmin > tmax || tmin < 1e-3) return null
      const n: V = [0, 0, 0]
      n[axis] = sign
      return { t: tmin, n: toWorld(n), id }
    },
  }
}

const ground: Obj = {
  id: 1,
  colors: ['#9ad17a', '#76b05a', '#5a8f45'],
  hit(o, d) {
    if (d[1] >= -1e-9) return null
    const t = -o[1] / d[1]
    return t > 1e-3 ? { t, n: [0, 1, 0], id: 1 } : null
  },
}

const hexRgb = (h: string): V => {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function render(i: number): Uint8Array {
  const t = i / fps
  const bounce = (p: number) => Math.abs(Math.sin(t * Math.PI * 1.6 + p))
  const objs: Obj[] = [
    ground,
    sphere(2, [-2.2, 0.9 + bounce(0) * 1.2, 0.5], 0.9, ['#ff8a80', '#e0574b', '#a8382f']),
    sphere(3, [2.1, 0.7 + bounce(1.3) * 0.9, -0.4], 0.7, ['#80c8ff', '#4a98e0', '#2f68a8']),
    sphere(4, [0.3, 0.5 + bounce(2.1) * 1.5, 2.0], 0.5, ['#ffe680', '#e8c040', '#b08a20']),
    box(5, [0, 0.8, -1.8], [0.8, 0.8, 0.8], t * 1.1, ['#c9a0ff', '#9a6ae0', '#6c44a8']),
  ]
  const ang = 0.6 + t * 0.35
  const eye: V = [Math.sin(ang) * 6.5, 2.8, Math.cos(ang) * 6.5]
  const fwd = norm(sub([0, 0.8, 0], eye))
  const right = norm(cross(fwd, [0, 1, 0]))
  const up = cross(right, fwd)
  const light = norm([0.5, 1, 0.3])
  const SW = W * SS
  const SH = H * SS
  const ids = new Int16Array(SW * SH)
  const depth = new Float32Array(SW * SH)
  const col = new Uint8Array(SW * SH * 3)
  const shades = objs.map(o => o.colors.map(hexRgb))
  const sky0 = hexRgb('#bfe4ff')
  const sky1 = hexRgb('#eef8ff')
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const px = ((x + 0.5) / SW - 0.5) * 2 * (W / H) * 0.55
      const py = (0.5 - (y + 0.5) / SH) * 2 * 0.55
      const d = norm(add(add(fwd, mul(right, px)), mul(up, py)))
      let best: Hit | null = null
      for (const o of objs) {
        const h = o.hit(eye, d)
        if (h && (!best || h.t < best.t)) best = h
      }
      const p = y * SW + x
      if (!best) {
        const k = Math.max(0, Math.min(1, y / (SH * 0.3)))
        col.set([sky0[0] + (sky1[0] - sky0[0]) * k, sky0[1] + (sky1[1] - sky0[1]) * k, sky0[2] + (sky1[2] - sky0[2]) * k], p * 3)
        ids[p] = 0
        depth[p] = 1e9
        continue
      }
      const pos = add(eye, mul(d, best.t))
      const lit = dot(best.n, light)
      let shadow = false
      for (const o of objs) {
        if (o.id === best.id) continue
        if (o.hit(add(pos, mul(best.n, 1e-3)), light)) {
          shadow = true
          break
        }
      }
      const band = shadow || lit < 0.1 ? 2 : lit < 0.6 ? 1 : 0
      col.set(shades[best.id - 1]![band]!, p * 3)
      ids[p] = best.id
      depth[p] = best.t
    }
  }
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const X = x * SS + sx
          const Y = y * SS + sy
          const p = Y * SW + X
          let edge = false
          for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]] as const) {
            const q = Math.min(SH - 1, Math.max(0, Y + dy)) * SW + Math.min(SW - 1, Math.max(0, X + dx))
            if (ids[q] !== ids[p] && (ids[q]! > ids[p]! || ids[p] === 1 || ids[q] === 0)) edge = true
            if (ids[q] === ids[p] && ids[p] !== 1 && Math.abs(depth[q]! - depth[p]!) > 0.05 * depth[p]!) edge = true
          }
          if (edge && ids[p] !== 0) {
            r += 34
            g += 30
            b += 46
          } else {
            r += col[p * 3]!
            g += col[p * 3 + 1]!
            b += col[p * 3 + 2]!
          }
        }
      }
      const o = (y * W + x) * 4
      out[o] = r / (SS * SS)
      out[o + 1] = g / (SS * SS)
      out[o + 2] = b / (SS * SS)
      out[o + 3] = 255
    }
  }
  return out
}

export async function make(file: string) {
  await writeClip(file, W, H, fps, fps * seconds, render)
}
