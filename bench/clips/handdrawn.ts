import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { rng, writeClip } from './common.ts'

const W = 1280
const H = 720
const fps = 24
const seconds = 6

type P = [number, number]

function wobble(points: P[], amount: number, rand: () => number): P[] {
  return points.map(([x, y]) => [x + (rand() - 0.5) * amount, y + (rand() - 0.5) * amount])
}

function blob(ctx: SKRSContext2D, pts: P[], fill: string, rand: () => number, line = 4) {
  const p = wobble(pts, 2.4, rand)
  const n = p.length
  ctx.beginPath()
  ctx.moveTo((p[0]![0] + p[1]![0]) / 2, (p[0]![1] + p[1]![1]) / 2)
  for (let i = 1; i <= n; i++) {
    const a = p[i % n]!
    const b = p[(i + 1) % n]!
    ctx.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  }
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = line + (rand() - 0.5) * 1.2
  ctx.strokeStyle = '#2b2118'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function oval(cx: number, cy: number, rx: number, ry: number, n = 10, rot = 0): P[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    const x = Math.cos(a) * rx
    const y = Math.sin(a) * ry
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]
  })
}

function stroke(ctx: SKRSContext2D, pts: P[], rand: () => number, width = 4) {
  const p = wobble(pts, 2, rand)
  ctx.beginPath()
  ctx.moveTo(p[0]![0], p[0]![1])
  for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i]![0], p[i]![1], (p[i]![0] + p[i + 1]![0]) / 2, (p[i]![1] + p[i + 1]![1]) / 2)
  ctx.lineTo(p[p.length - 1]![0], p[p.length - 1]![1])
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.strokeStyle = '#2b2118'
  ctx.stroke()
}

export function drawing(i: number) {
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')
  const t = i / fps
  const rand = rng(1000 + i)
  ctx.fillStyle = '#f6efe1'
  ctx.fillRect(0, 0, W, H)
  const ground = rng(7)
  ctx.fillStyle = '#e4d6bb'
  ctx.fillRect(0, 560, W, 160)
  stroke(ctx, [[0, 560], [400, 556], [800, 563], [1280, 558]], ground, 3)
  blob(ctx, oval(1050, 470, 26, 90, 8), '#7cb07a', rand)
  const sway = Math.sin(t * 3) * 0.25
  blob(ctx, oval(1050 + Math.sin(sway) * 70, 380, 60, 32, 9, sway), '#9fd39a', rand)
  const x = 160 + t * 150
  const bounce = Math.abs(Math.sin(t * Math.PI * 2)) * 40
  const y = 470 - bounce
  blob(ctx, oval(x, 575, 80 - bounce * 0.4, 14, 8), '#cdbb98', rand, 0.01)
  const step = Math.sin(t * Math.PI * 4)
  blob(ctx, oval(x - 30 + step * 18, y + 85, 22, 16, 7), '#e06d5a', rand)
  blob(ctx, oval(x + 30 - step * 18, y + 85, 22, 16, 7), '#e06d5a', rand)
  blob(ctx, oval(x, y, 78, 92 - bounce * 0.2, 12), '#f2a65a', rand)
  blob(ctx, oval(x + 18, y + 28, 42, 34, 9), '#f7c08a', rand, 0.01)
  const wave = Math.sin(t * 6) * 0.7
  stroke(ctx, [[x + 70, y], [x + 105, y - 30 - wave * 30], [x + 120 + wave * 20, y - 75 - wave * 10]], rand, 9)
  stroke(ctx, [[x - 70, y + 10], [x - 100, y + 40], [x - 105, y + 70]], rand, 9)
  blob(ctx, oval(x - 22, y - 30, 16, 20, 7), '#ffffff', rand, 3)
  blob(ctx, oval(x + 26, y - 30, 16, 20, 7), '#ffffff', rand, 3)
  blob(ctx, oval(x - 18 + step * 3, y - 26, 6, 8, 6), '#2b2118', rand, 0.01)
  blob(ctx, oval(x + 30 + step * 3, y - 26, 6, 8, 6), '#2b2118', rand, 0.01)
  stroke(ctx, [[x - 20, y + 20], [x + 4, y + 36 + step * 4], [x + 30, y + 18]], rand, 5)
  const bx = 900 - t * 90
  const by = 520 - Math.abs(Math.sin(t * Math.PI * 1.5)) * 220
  blob(ctx, oval(bx, by, 34, 34, 9), '#5b8fd6', rand)
  blob(ctx, oval(bx - 8, by - 10, 12, 9, 6), '#9cc0f0', rand, 0.01)
  return c
}

export async function make(file: string) {
  const drawings = new Map<number, ReturnType<typeof drawing>>()
  await writeClip(file, W, H, fps, fps * seconds, i => {
    const d = i - (i % 2)
    if (!drawings.has(d)) drawings.set(d, drawing(d))
    return drawings.get(d)!
  })
}
