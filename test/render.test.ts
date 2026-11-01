import { expect, test } from 'bun:test'
import { createCanvas } from '@napi-rs/canvas'
import { decode as decodeMovie, encode, frameToSvg, rect, toScene, type Scene } from '../src/index.ts'
import { frameRenderer } from '../src/node.ts'
import { memorySource, SvvPlayer, SvvSource } from '../src/player.ts'

const decode = (b: Uint8Array) => toScene(decodeMovie(b))

const scene: Scene = {
  width: 160,
  height: 90,
  duration: 1,
  background: [255, 255, 255, 255],
  nodes: [{ type: 'shape', path: rect(0, 0, 20, 90), fill: { type: 'solid', color: [255, 0, 0, 255] }, transform: { x: [{ t: 0, v: 0 }, { t: 1, v: 140 }] } }],
}

function redColumns(px: Uint8ClampedArray | Buffer, width: number, height: number): [number, number] {
  const row = Math.floor(height / 2)
  let first = -1
  let last = -1
  for (let x = 0; x < width; x++) {
    const i = (row * width + x) * 4
    if (px[i]! > 200 && px[i + 1]! < 60) {
      if (first < 0) first = x
      last = x
    }
  }
  return [first, last]
}

test('renders the same frame at any resolution', async () => {
  const d = decode(encode(scene))
  for (const width of [160, 640, 2560]) {
    const r = await frameRenderer(d, { width })
    const [first, last] = redColumns(await r.rgba(0.5), r.width, r.height)
    const k = width / 160
    expect(first).toBeGreaterThanOrEqual(Math.floor(70 * k) - 1)
    expect(last).toBeLessThanOrEqual(Math.ceil(90 * k) + 1)
  }
})

test('renders any instant, not just frame boundaries', async () => {
  const r = await frameRenderer(decode(encode(scene)), { width: 1600 })
  const [a] = redColumns(await r.rgba(0.5), r.width, r.height)
  const [b] = redColumns(await r.rgba(0.5 + 1 / 1000), r.width, r.height)
  expect(b - a).toBeGreaterThanOrEqual(1)
  expect(b - a).toBeLessThanOrEqual(2)
})

test('view option zooms into a region', async () => {
  const r = await frameRenderer(decode(encode(scene)), { width: 800, view: [70, 40, 20, 10] })
  const [first, last] = redColumns(await r.rgba(0.5), r.width, r.height)
  expect(first).toBe(0)
  expect(last).toBe(r.width - 1)
})

test('frame exports as standalone SVG', () => {
  const svg = frameToSvg(decode(encode(scene)), 0.5)
  expect(svg).toStartWith('<svg')
  expect(svg).toContain('matrix(1 0 0 1 70 0)')
})

test('player draws into a canvas at device pixel size', async () => {
  const canvas = createCanvas(1, 1)
  const source = await SvvSource.open(memorySource(encode(scene)))
  const player = new SvvPlayer(canvas as unknown as HTMLCanvasElement, source)
  await player.ready()
  player.resize(320, 180, 2)
  expect(canvas.width).toBe(640)
  player.currentTime = 0.5
  const px = canvas.getContext('2d').getImageData(0, 0, 640, 360).data
  const [first] = redColumns(px, 640, 360)
  expect(first).toBeGreaterThanOrEqual(279)
  expect(first).toBeLessThanOrEqual(281)
  player.fps = 4
  player.currentTime = 0.6
  const [snapped] = redColumns(canvas.getContext('2d').getImageData(0, 0, 640, 360).data, 640, 360)
  expect(snapped).toBe(first)
})
