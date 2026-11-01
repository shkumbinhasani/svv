import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { rng, writeClip } from './common.ts'

const W = 1280
const H = 720
const fps = 24
const seconds = 6
const PAN = 1.7
const PW = W + Math.ceil(PAN * fps * seconds) + 8

function painting(): Canvas {
  const c = createCanvas(PW, H)
  const ctx = c.getContext('2d')
  const rand = rng(42)
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#5b8fd9')
  sky.addColorStop(0.55, '#a9c9ef')
  sky.addColorStop(1, '#f3d9c4')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, PW, H)
  ctx.filter = 'blur(10px)'
  for (let i = 0; i < 60; i++) {
    const x = rand() * PW
    const y = 60 + rand() * 220
    ctx.fillStyle = `rgba(255,${240 + Math.floor(rand() * 15)},${235 + Math.floor(rand() * 20)},${0.35 + rand() * 0.4})`
    ctx.beginPath()
    ctx.ellipse(x, y, 60 + rand() * 120, 20 + rand() * 40, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.filter = 'blur(2px)'
  const ridge = (base: number, amp: number, color: string, seed: number) => {
    const r = rng(seed)
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let x = 0; x <= PW; x += 40) ctx.lineTo(x, base - amp * (0.5 + 0.5 * Math.sin(x / 210 + seed) + 0.3 * r()))
    ctx.lineTo(PW, H)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  ridge(430, 120, '#8aa5c9', 1)
  ridge(480, 80, '#6f9a8a', 2)
  ridge(540, 50, '#5c8f4e', 3)
  ctx.filter = 'none'
  for (let i = 0; i < 9000; i++) {
    const x = rand() * PW
    const y = 520 + rand() * 200
    const g = 100 + Math.floor(rand() * 80)
    ctx.strokeStyle = `rgba(${40 + Math.floor(rand() * 40)},${g},${30 + Math.floor(rand() * 30)},0.55)`
    ctx.lineWidth = 1 + rand() * 2
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (rand() - 0.5) * 6, y - 6 - rand() * 14)
    ctx.stroke()
  }
  for (let i = 0; i < 7; i++) {
    const x = 150 + i * 340 + rand() * 120
    ctx.fillStyle = '#4a3a2c'
    ctx.fillRect(x - 6, 420, 12, 120)
    ctx.filter = 'blur(1.5px)'
    for (let k = 0; k < 40; k++) {
      ctx.fillStyle = `rgba(${40 + Math.floor(rand() * 40)},${110 + Math.floor(rand() * 60)},${50 + Math.floor(rand() * 30)},0.7)`
      ctx.beginPath()
      ctx.arc(x + (rand() - 0.5) * 120, 390 + (rand() - 0.5) * 90, 14 + rand() * 18, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.filter = 'none'
  }
  const img = ctx.getImageData(0, 0, PW, H)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rand() - 0.5) * 10
    img.data[i] = img.data[i]! + n
    img.data[i + 1] = img.data[i + 1]! + n
    img.data[i + 2] = img.data[i + 2]! + n
  }
  ctx.putImageData(img, 0, 0)
  return c
}

function cel(ctx: SKRSContext2D, path: () => void, base: string, shade: string, shadeClip: () => void) {
  ctx.save()
  path()
  ctx.fillStyle = base
  ctx.fill()
  ctx.clip()
  shadeClip()
  ctx.fillStyle = shade
  ctx.fill()
  ctx.restore()
  path()
  ctx.lineWidth = 2.5
  ctx.strokeStyle = '#2a1a2a'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function character(ctx: SKRSContext2D, x: number, y: number, t: number, palette: { hair: string; hairShade: string; coat: string; coatShade: string }, flip: number) {
  const walk = Math.sin(t * Math.PI * 2 * 1.2)
  const e = (cx: number, cy: number, rx: number, ry: number, rot = 0) => () => {
    ctx.beginPath()
    ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2)
  }
  const poly = (pts: [number, number][]) => () => {
    ctx.beginPath()
    ctx.moveTo(pts[0]![0], pts[0]![1])
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.closePath()
  }
  ctx.save()
  ctx.translate(x, y + Math.abs(walk) * -6)
  ctx.scale(flip, 1)
  cel(ctx, poly([[-18, 120], [-6, 120], [-4 + walk * 14, 230], [-20 + walk * 14, 230]]), '#3b3355', '#2a2440', poly([[-12, 120], [-6, 120], [-4 + walk * 14, 230], [-12 + walk * 14, 230]]))
  cel(ctx, poly([[6, 120], [18, 120], [20 - walk * 14, 230], [4 - walk * 14, 230]]), '#3b3355', '#2a2440', poly([[12, 120], [18, 120], [20 - walk * 14, 230], [12 - walk * 14, 230]]))
  cel(ctx, poly([[-40, 10], [40, 10], [52, 130], [-52, 130]]), palette.coat, palette.coatShade, poly([[10, 10], [40, 10], [52, 130], [14, 130]]))
  cel(ctx, poly([[40, 18], [54, 22], [60 - walk * 18, 110], [46 - walk * 18, 112]]), palette.coat, palette.coatShade, poly([[48, 18], [54, 22], [60 - walk * 18, 110], [52 - walk * 18, 112]]))
  cel(ctx, e(0, -40, 42, 48), '#f6d5bd', '#e2b49a', e(18, -30, 30, 44))
  cel(ctx, () => {
    ctx.beginPath()
    ctx.moveTo(-46, -30)
    ctx.quadraticCurveTo(-50, -100, 0, -96)
    ctx.quadraticCurveTo(52, -100, 48, -30)
    ctx.lineTo(36, -50)
    ctx.lineTo(24, -36)
    ctx.lineTo(10, -56)
    ctx.lineTo(-6, -40)
    ctx.lineTo(-22, -58)
    ctx.lineTo(-34, -36)
    ctx.closePath()
  }, palette.hair, palette.hairShade, e(30, -60, 30, 40))
  const blink = (t * 24) % 60 < 3
  ctx.fillStyle = '#2a1a2a'
  if (blink) {
    ctx.fillRect(-22, -34, 14, 3)
    ctx.fillRect(10, -34, 14, 3)
  } else {
    cel(ctx, e(-15, -32, 7, 11), '#3d2a5c', '#24163b', e(-15, -27, 7, 6))
    cel(ctx, e(17, -32, 7, 11), '#3d2a5c', '#24163b', e(17, -27, 7, 6))
  }
  ctx.restore()
}

export async function make(file: string) {
  const bg = painting()
  const frame = createCanvas(W, H)
  const ctx = frame.getContext('2d')
  const petals = rng(5)
  const petalSeeds = Array.from({ length: 18 }, () => [petals() * W, petals() * H, 0.5 + petals()])
  await writeClip(file, W, H, fps, fps * seconds, i => {
    const t = i / fps
    ctx.drawImage(bg, -PAN * i, 0)
    const drawn = Math.floor(i / 3) * 3
    const td = drawn / fps
    character(ctx, 520 + Math.sin(td) * 10, 380, td, { hair: '#e8b04e', hairShade: '#c08a2e', coat: '#d6455d', coatShade: '#a8324a' }, 1)
    character(ctx, 760, 395, td + 0.4, { hair: '#4a5fc1', hairShade: '#33449a', coat: '#f2f0ea', coatShade: '#c9c3b8' }, -1)
    const p2 = Math.floor(i / 2) * 2 / fps
    for (const [px, py, s] of petalSeeds) {
      const x = (px! + p2 * 60 * s!) % W
      const y = (py! + p2 * 90 * s!) % H
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(p2 * 3 * s!)
      ctx.fillStyle = '#f7b6c8'
      ctx.beginPath()
      ctx.ellipse(0, 0, 7 * s!, 4 * s!, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    void t
    return frame
  })
}

export async function preview(i: number) {
  const bg = painting()
  const c = createCanvas(W, H)
  const ctx = c.getContext('2d')
  ctx.drawImage(bg, -PAN * i, 0)
  character(ctx, 520, 380, i / fps, { hair: '#e8b04e', hairShade: '#c08a2e', coat: '#d6455d', coatShade: '#a8324a' }, 1)
  character(ctx, 760, 395, i / fps + 0.4, { hair: '#4a5fc1', hairShade: '#33449a', coat: '#f2f0ea', coatShade: '#c9c3b8' }, -1)
  return c
}
