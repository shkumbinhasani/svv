import type { ImageAsset, Keyframe, SceneNode } from '../model.ts'
import { encodeImage } from '../media.ts'

export interface Plate {
  image: ImageAsset
  rgba: Uint8Array
  width: number
  height: number
  minX: number
  minY: number
  offsets: [number, number][]
  node(asset: number, fps: number): SceneNode
}

function shift(a: Uint8Array, b: Uint8Array, w: number, h: number, range: number, center: [number, number] = [0, 0], stride = 2): [number, number] {
  const [cx, cy] = center
  const margin = range + Math.max(Math.abs(cx), Math.abs(cy)) + 1
  const cost = (dx: number, dy: number) => {
    let s = 0
    let n = 0
    for (let y = margin; y < h - margin; y += stride) {
      for (let x = margin; x < w - margin; x += stride) {
        s += Math.abs(a[(y + dy) * w + x + dx]! - b[y * w + x]!)
        n++
      }
    }
    return s / n
  }
  let bx = cx
  let by = cy
  let best = Infinity
  for (let dy = cy - range; dy <= cy + range; dy++) {
    for (let dx = cx - range; dx <= cx + range; dx++) {
      const c = cost(dx, dy)
      if (c < best - 1e-9 || (Math.abs(c - best) < 1e-9 && Math.abs(dx - cx) + Math.abs(dy - cy) < Math.abs(bx - cx) + Math.abs(by - cy))) {
        best = c
        bx = dx
        by = dy
      }
    }
  }
  const sub = (cm: number, c0: number, cp: number) => {
    const d = cm - 2 * c0 + cp
    return d > 1e-9 ? Math.max(-0.5, Math.min(0.5, (cm - cp) / (2 * d))) : 0
  }
  const fx = Math.abs(bx - cx) < range ? sub(cost(bx - 1, by), best, cost(bx + 1, by)) : 0
  const fy = Math.abs(by - cy) < range ? sub(cost(bx, by - 1), best, cost(bx, by + 1)) : 0
  return [bx + fx, by + fy]
}

function sample(img: Uint8Array, w: number, h: number, x: number, y: number, out: number[]) {
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(y)))
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = Math.max(0, Math.min(1, x - x0))
  const fy = Math.max(0, Math.min(1, y - y0))
  for (let c = 0; c < 3; c++) {
    const a = img[(y0 * w + x0) * 4 + c]!
    const b = img[(y0 * w + x1) * 4 + c]!
    const d = img[(y1 * w + x0) * 4 + c]!
    const e = img[(y1 * w + x1) * 4 + c]!
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy
  }
}

export async function buildPlate(
  sparse: Uint8Array[],
  smalls: Uint8Array[],
  lumas: Uint8Array[],
  every: number,
  width: number,
  height: number,
  force: boolean,
  crf: number,
  log: (m: string) => void,
): Promise<Plate | null> {
  const sw = width >> 2
  const sh = height >> 2
  const offsets: [number, number][] = [[0, 0]]
  for (let f = 1; f < smalls.length; f++) {
    const [sx, sy] = shift(smalls[f - 1]!, smalls[f]!, sw, sh, 6)
    const [dx, dy] = shift(lumas[f - 1]!, lumas[f]!, width, height, 3, [Math.round(sx * 4), Math.round(sy * 4)], 3)
    const p = offsets[f - 1]!
    offsets.push([p[0] + dx, p[1] + dy])
  }
  const minX = Math.floor(Math.min(...offsets.map(o => o[0])))
  const minY = Math.floor(Math.min(...offsets.map(o => o[1])))
  const pw = Math.ceil(Math.max(...offsets.map(o => o[0]))) - minX + width
  const ph = Math.ceil(Math.max(...offsets.map(o => o[1]))) - minY + height
  const rgba = new Uint8Array(pw * ph * 4)
  const vals = [new Uint8Array(sparse.length), new Uint8Array(sparse.length), new Uint8Array(sparse.length)]
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      let n = 0
      sparse.forEach((fr, i) => {
        const o = offsets[i * every]!
        const x = Math.round(px + minX - o[0])
        const y = Math.round(py + minY - o[1])
        if (x < 0 || y < 0 || x >= width || y >= height) return
        const k = (y * width + x) * 4
        vals[0]![n] = fr[k]!
        vals[1]![n] = fr[k + 1]!
        vals[2]![n] = fr[k + 2]!
        n++
      })
      const o = (py * pw + px) * 4
      for (let c = 0; c < 3; c++) {
        const v = vals[c]!.subarray(0, n).sort()
        rgba[o + c] = n ? v[n >> 1]! : 0
      }
      rgba[o + 3] = 255
    }
  }
  let match = 0
  let total = 0
  const px: number[] = [0, 0, 0]
  sparse.forEach((fr, i) => {
    const o = offsets[i * every]!
    for (let y = 0; y < height; y += 3) {
      for (let x = 0; x < width; x += 3) {
        sample(rgba, pw, ph, x + o[0] - minX, y + o[1] - minY, px)
        const k = (y * width + x) * 4
        if (Math.abs(px[0]! - fr[k]!) + Math.abs(px[1]! - fr[k + 1]!) + Math.abs(px[2]! - fr[k + 2]!) < 30) match++
        total++
      }
    }
  })
  let texture = 0
  for (let y = 1; y < ph; y += 2) {
    for (let x = 1; x < pw; x += 2) {
      const o = (y * pw + x) * 4
      texture += Math.abs(rgba[o]! - rgba[o - 4]!) + Math.abs(rgba[o + 1]! - rgba[o - pw * 4 + 1]!)
    }
  }
  texture /= (pw * ph) / 4
  const fit = match / total
  log(`plate: ${pw}x${ph}, background fit ${(fit * 100).toFixed(0)}%, texture ${texture.toFixed(2)}`)
  if (!force && (fit < 0.5 || texture < 3)) return null
  const image = await encodeImage(rgba, pw, ph, crf, 'avif')
  log(`plate image: ${image.data.length} bytes`)
  return {
    image,
    rgba,
    width: pw,
    height: ph,
    minX,
    minY,
    offsets,
    node(asset, fps) {
      const track = (axis: 0 | 1, base: number): Keyframe<number>[] => {
        const all = offsets.map((o, f) => ({ t: f / fps, v: base - o[axis] }))
        const kept: Keyframe<number>[] = [all[0]!]
        for (let i = 1; i < all.length - 1; i++) {
          const a = kept[kept.length - 1]!
          const c = all[i + 1]!
          const u = (all[i]!.t - a.t) / (c.t - a.t)
          if (Math.abs(a.v + (c.v - a.v) * u - all[i]!.v) > 0.08) kept.push(all[i]!)
        }
        if (all.length > 1) kept.push(all[all.length - 1]!)
        return kept
      }
      return { type: 'image', asset, width: pw, height: ph, transform: { x: track(0, minX), y: track(1, minY) } }
    },
  }
}

function morph(mask: Uint8Array, w: number, h: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      let v = mask[i]!
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const n = mask[ny * w + nx]!
        v = grow ? v | n : v & n
      }
      out[i] = v
    }
  }
  return out
}

export function foregroundMask(frame: Uint8Array, plate: Plate, f: number, width: number, height: number): Uint8Array {
  const o = plate.offsets[Math.min(f, plate.offsets.length - 1)]!
  const mask = new Uint8Array(width * height)
  const px: number[] = [0, 0, 0]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sample(plate.rgba, plate.width, plate.height, x + o[0] - plate.minX, y + o[1] - plate.minY, px)
      const k = (y * width + x) * 4
      if (Math.abs(px[0]! - frame[k]!) + Math.abs(px[1]! - frame[k + 1]!) + Math.abs(px[2]! - frame[k + 2]!) > 48) mask[y * width + x] = 1
    }
  }
  return morph(morph(morph(mask, width, height, false), width, height, true), width, height, true)
}
