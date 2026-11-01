import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { ellipse, encode, fontFromBytes, rect, type Scene } from '../src/index.ts'
import { encodeImage, encodeVideoLayer } from '../src/media.ts'

const root = join(import.meta.dir, '..')
const dir = join(root, 'out', 'browser')
mkdirSync(dir, { recursive: true })
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const w = 64
const h = 64
const frame = (t: number) => {
  const b = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) b.set(t < 1 ? [220, 30, 30, 255] : [30, 30, 220, 255], i * 4)
  return b
}
const video = encodeVideoLayer(frame, { width: w, height: h, fps: 10, crf: 30, chunks: [[0, 1], [1, 2]] })
const green = new Uint8Array(64)
for (let i = 0; i < 16; i++) green.set([0, 200, 0, 255], i * 4)
const image = await encodeImage(green, 4, 4, 0, 'png')
const font = fontFromBytes(readFileSync(join(root, 'examples', 'fonts', 'lilita', 'LilitaOne-Regular.ttf')), 'SVV')
const scene: Scene = {
  width: 400,
  height: 100,
  duration: 2,
  loop: false,
  background: [255, 255, 255, 255],
  assets: [video, image, font],
  nodes: [
    { type: 'video', asset: 0, width: 100, height: 100 },
    { type: 'image', asset: 1, x: 100, width: 100, height: 100 },
    { type: 'shape', path: rect(200, 0, 100, 100), fill: { type: 'solid', color: [255, 0, 0, 255] }, mask: { node: { type: 'shape', path: ellipse(250, 50, 20), fill: { type: 'solid', color: [0, 0, 0, 255] } } } },
    { type: 'text', text: 'SVV', font: 2, size: 60, align: 'center', fill: { type: 'solid', color: [0, 0, 0, 255] }, transform: { x: 350, y: 75 }, filters: [{ type: 'glow', radius: 6, color: [255, 0, 255, 255], strength: 2 }] },
  ],
}
const bytes = encode(scene, { chunkDuration: 1 })
writeFileSync(join(dir, 'test.svv'), bytes)
const build = await Bun.build({ entrypoints: [join(root, 'src', 'player.ts')], outdir: dir, naming: 'svv-player.js', target: 'browser', minify: true })
if (!build.success) throw new AggregateError(build.logs)
writeFileSync(
  join(dir, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script type="module" src="./svv-player.js"></script><svv-player id="p" src="test.svv" style="width:400px;height:100px" muted></svv-player>',
)

const ranges: string[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const file = Bun.file(join(dir, path === '/' ? 'index.html' : path))
    if (!(await file.exists())) return new Response('not found', { status: 404 })
    const range = req.headers.get('range')
    if (path.endsWith('.svv') && range) {
      ranges.push(range)
      const [a, b] = range.replace('bytes=', '').split('-').map(Number)
      const data = new Uint8Array(await file.arrayBuffer())
      const end = Math.min(data.length - 1, b!)
      return new Response(data.slice(a, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${end}/${data.length}`, 'Content-Type': 'application/octet-stream' } })
    }
    return new Response(file)
  },
})

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
try {
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  await page.goto(`http://localhost:${server.port}/`)
  await page.waitForFunction(() => (document.getElementById('p') as unknown as { player: unknown }).player, { timeout: 10000 })
  await new Promise(r => setTimeout(r, 300))
  const probe = (t: number) =>
    page.evaluate(async (t: number) => {
      const p = document.getElementById('p') as unknown as { currentTime: number; shadowRoot: ShadowRoot }
      p.currentTime = t
      await new Promise(r => setTimeout(r, 700))
      const canvas = p.shadowRoot.querySelector('canvas')!
      const ctx = canvas.getContext('2d')!
      const px = (x: number, y: number) => Array.from(ctx.getImageData((x * canvas.width) / 400, (y * canvas.height) / 100, 1, 1).data)
      return { video: px(50, 50), image: px(150, 50), maskIn: px(250, 50), maskOut: px(205, 5), text: px(350, 50), glow: px(312, 25) }
    }, t)
  const before = ranges.length
  const a = await probe(0.5)
  const b = await probe(1.5)
  const near = (p: number[], q: number[], tol = 40) => p.every((v, i) => Math.abs(v - q[i]!) <= tol)
  const checks = {
    'video layer, chunk 1 (red)': near(a.video, [220, 30, 30, 255]),
    'video layer, chunk 2 (blue)': near(b.video, [30, 30, 220, 255]),
    'raster image': near(a.image, [0, 200, 0, 255], 2),
    'mask inside': near(a.maskIn, [255, 0, 0, 255], 2),
    'mask outside': near(a.maskOut, [255, 255, 255, 255], 2),
    'glow': a.glow[1]! < 240 && a.glow[0]! > 200 && a.glow[2]! > 200,
    'seek uses range requests': ranges.length > before || ranges.length > 1,
    'no page errors': errors.length === 0,
  }
  console.log(JSON.stringify({ a, b, ranges, errors, checks }, null, 1))
  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  if (failed.length) {
    console.error('FAILED:', failed.map(([k]) => k).join(', '))
    process.exitCode = 1
  } else console.log('all browser checks passed')
} finally {
  await browser.close()
  server.stop()
}
