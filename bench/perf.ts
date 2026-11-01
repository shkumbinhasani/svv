import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = join(import.meta.dir, '..')
const dir = join(root, 'out', 'perf')
mkdirSync(dir, { recursive: true })
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const files = process.argv.slice(2).filter(a => !a.startsWith('--'))
const targets = files.length ? files : ['examples/svv/titles.svv', 'examples/svv/cutout.svv', 'examples/svv/confetti.svv', 'examples/svv/landscape.svv', 'out/bench/handdrawn.svv']
const sizes: [number, number][] = [
  [1280, 720],
  [2560, 1440],
]

const build = await Bun.build({ entrypoints: [join(root, 'src', 'player.ts')], outdir: dir, naming: 'svv-player.js', target: 'browser', minify: true })
if (!build.success) throw new AggregateError(build.logs)
writeFileSync(join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"><canvas id="c"></canvas>')

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = decodeURIComponent(new URL(req.url).pathname)
    const file = Bun.file(path.startsWith('/files/') ? join(root, path.slice(7)) : join(dir, path === '/' ? 'index.html' : path))
    return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 })
  },
})

const browser = await puppeteer.launch({ executablePath: chrome, protocolTimeout: 600000, headless: !process.argv.includes('--headed'), args: ['--enable-gpu-rasterization', '--ignore-gpu-blocklist'] })
try {
  const page = await browser.newPage()
  page.on('pageerror', e => console.error(String(e)))
  await page.goto(`http://localhost:${server.port}/`)
  console.log('| File | Canvas | Frames shown per second | Slowest frame (ms) | Draw time per frame (ms) |')
  console.log('|---|---|---:|---:|---:|')
  for (const file of targets) {
    for (const [w, h] of sizes) {
      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: w / 1280 })
      await page.goto(`http://localhost:${server.port}/`)
      const r = await page.evaluate(
        async (url: string) => {
          const bundle = '/svv-player.js'
          await import(bundle)
          const el = document.createElement('svv-player') as HTMLElement & { player: { render(): void; play(): void; pause(): void } }
          el.setAttribute('src', url)
          el.setAttribute('muted', '')
          el.style.cssText = 'width:1280px;height:720px'
          document.body.replaceChildren(el)
          await new Promise(r => el.addEventListener('load', r, { once: true }))
          const p = el.player
          const render = p.render.bind(p)
          let busy = 0
          p.render = () => {
            const t0 = performance.now()
            render()
            busy += performance.now() - t0
          }
          p.play()
          const stamps: number[] = []
          const end = performance.now() + 4000
          await new Promise<void>(done => {
            const tick = (now: number) => {
              stamps.push(now)
              if (now < end) requestAnimationFrame(tick)
              else done()
            }
            requestAnimationFrame(tick)
          })
          p.pause()
          const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!)
          return { fps: (gaps.length * 1000) / (stamps[stamps.length - 1]! - stamps[0]!), worst: Math.max(...gaps), busy: busy / gaps.length }
        },
        `/files/${file}`,
      )
      console.log(`| ${file} | ${w}×${h} | ${r.fps.toFixed(0)} | ${r.worst.toFixed(0)} | ${r.busy.toFixed(1)} |`)
    }
  }
} finally {
  await browser.close()
  server.stop()
}
