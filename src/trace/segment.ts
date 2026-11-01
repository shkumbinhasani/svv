export type Rgb = [number, number, number]

const dist2 = (a: Rgb, r: number, g: number, b: number) => {
  const dr = a[0] - r
  const dg = a[1] - g
  const db = a[2] - b
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db
}

export function samplePixels(frame: Uint8Array, width: number, height: number, out: number[], step: number, mask?: Uint8Array) {
  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = y * width + x
      if (mask && !mask[i]) continue
      const o = i * 4
      let flat = true
      for (const n of [o - 4, o + 4, o - width * 4, o + width * 4]) {
        if (Math.abs(frame[n]! - frame[o]!) + Math.abs(frame[n + 1]! - frame[o + 1]!) + Math.abs(frame[n + 2]! - frame[o + 2]!) > 18) {
          flat = false
          break
        }
      }
      if (flat) out.push(frame[o]!, frame[o + 1]!, frame[o + 2]!)
    }
  }
}

export function buildPalette(samples: number[], maxColors: number, mergeDistance = 10): Rgb[] {
  const n = samples.length / 3
  if (!n) return [[255, 255, 255]]
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const pick = (i: number): Rgb => [samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!]
  const centers: Rgb[] = [pick(Math.floor(rand() * n))]
  const d = new Float64Array(n).fill(Infinity)
  while (centers.length < maxColors) {
    const c = centers[centers.length - 1]!
    let total = 0
    for (let i = 0; i < n; i++) {
      d[i] = Math.min(d[i]!, dist2(c, samples[i * 3]!, samples[i * 3 + 1]!, samples[i * 3 + 2]!))
      total += d[i]!
    }
    if (total <= 0) break
    let r = rand() * total
    let k = 0
    while (k < n - 1 && (r -= d[k]!) > 0) k++
    centers.push(pick(k))
  }
  const assign = new Int32Array(n)
  for (let iter = 0; iter < 10; iter++) {
    const sum = centers.map(() => [0, 0, 0, 0])
    for (let i = 0; i < n; i++) {
      const r = samples[i * 3]!
      const g = samples[i * 3 + 1]!
      const b = samples[i * 3 + 2]!
      let best = 0
      let bd = Infinity
      centers.forEach((c, k) => {
        const dd = dist2(c, r, g, b)
        if (dd < bd) {
          bd = dd
          best = k
        }
      })
      assign[i] = best
      const s = sum[best]!
      s[0]! += r
      s[1]! += g
      s[2]! += b
      s[3]!++
    }
    sum.forEach((s, k) => {
      if (s[3]) centers[k] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!]
    })
  }
  const counts = new Int32Array(centers.length)
  for (let i = 0; i < n; i++) counts[assign[i]!]!++
  const order = centers.map((c, k) => ({ c, k, count: counts[k]! })).sort((a, b) => b.count - a.count)
  const out: Rgb[] = []
  for (const { c, count } of order) {
    if (count < n * 0.0004) continue
    if (out.some(o => dist2(o, c[0], c[1], c[2]) < mergeDistance * mergeDistance * 9)) continue
    out.push([Math.round(c[0]), Math.round(c[1]), Math.round(c[2])])
  }
  return out
}

export class Quantizer {
  private cache = new Int16Array(1 << 18).fill(-1)
  constructor(readonly palette: Rgb[]) {}

  index(r: number, g: number, b: number): number {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2)
    let v = this.cache[key]!
    if (v < 0) {
      let bd = Infinity
      this.palette.forEach((c, k) => {
        const dd = dist2(c, r, g, b)
        if (dd < bd) {
          bd = dd
          v = k
        }
      })
      this.cache[key] = v
    }
    return v
  }
}

export interface Regions {
  width: number
  height: number
  id: Int32Array
  color: number[]
  area: number[]
  count: number
}

export function segment(frame: Uint8Array, width: number, height: number, q: Quantizer, minArea: number, mask?: Uint8Array): Regions {
  const n = width * height
  const label = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) label[i] = -1
    else label[i] = q.index(frame[i * 4]!, frame[i * 4 + 1]!, frame[i * 4 + 2]!)
  }
  const id = new Int32Array(n).fill(-1)
  const color: number[] = []
  const area: number[] = []
  const stack = new Int32Array(n)
  for (let s = 0; s < n; s++) {
    if (id[s] !== -1 || label[s] === -1) continue
    const r = color.length
    const l = label[s]!
    let top = 0
    stack[top++] = s
    id[s] = r
    let a = 0
    while (top) {
      const p = stack[--top]!
      a++
      const x = p % width
      if (x > 0 && id[p - 1] === -1 && label[p - 1] === l) (id[p - 1] = r), (stack[top++] = p - 1)
      if (x < width - 1 && id[p + 1] === -1 && label[p + 1] === l) (id[p + 1] = r), (stack[top++] = p + 1)
      if (p >= width && id[p - width] === -1 && label[p - width] === l) (id[p - width] = r), (stack[top++] = p - width)
      if (p < n - width && id[p + width] === -1 && label[p + width] === l) (id[p + width] = r), (stack[top++] = p + width)
    }
    color.push(l)
    area.push(a)
  }
  const regions: Regions = { width, height, id, color, area, count: color.length }
  mergeSmall(regions, minArea)
  return regions
}

function mergeSmall(R: Regions, minArea: number) {
  const { width, height, id } = R
  const n = width * height
  const parent = R.area.map((_, i) => i)
  const dropped = new Uint8Array(R.count)
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!
    return a
  }
  const area = [...R.area]
  const start = new Int32Array(R.count + 1)
  for (let i = 0; i < n; i++) if (id[i]! >= 0) start[id[i]! + 1]!++
  for (let r = 0; r < R.count; r++) start[r + 1]! += start[r]!
  const pix = new Int32Array(n)
  const fill = start.slice()
  for (let i = 0; i < n; i++) if (id[i]! >= 0) pix[fill[id[i]!]!++] = i
  const order = R.area.map((a, i) => i).filter(i => R.area[i]! < minArea).sort((a, b) => R.area[a]! - R.area[b]!)
  const counts = new Map<number, number>()
  for (const r of order) {
    const root = find(r)
    if (area[root]! >= minArea) continue
    counts.clear()
    for (let k = start[r]!; k < start[r + 1]!; k++) {
      const p = pix[k]!
      const x = p % width
      for (const nb of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (nb < 0 || nb >= n) continue
        const o = id[nb]!
        const f = o < 0 ? -1 : find(o)
        const t = f >= 0 && dropped[f] ? -1 : f
        if (t === root) continue
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    let best = -2
    let bc = -1
    for (const [t, c] of counts) {
      const score = t < 0 ? c * 0.5 : c
      if (score > bc) {
        bc = score
        best = t
      }
    }
    if (best === -2) continue
    if (best === -1) {
      dropped[root] = 1
      continue
    }
    parent[root] = best
    area[best]! += area[root]!
  }
  const finalId = new Int32Array(R.count)
  const color: number[] = []
  const newArea: number[] = []
  const remap = new Map<number, number>()
  for (let r = 0; r < R.count; r++) {
    const a = find(r)
    if (dropped[a]) {
      finalId[r] = -1
      continue
    }
    let m = remap.get(a)
    if (m === undefined) {
      m = color.length
      remap.set(a, m)
      color.push(R.color[a]!)
      newArea.push(0)
    }
    finalId[r] = m
  }
  for (let i = 0; i < n; i++) {
    if (id[i]! < 0) continue
    const f = finalId[id[i]!]!
    id[i] = f
    if (f >= 0) newArea[f]!++
  }
  R.color = color
  R.area = newArea
  R.count = color.length
}
