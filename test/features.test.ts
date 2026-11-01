import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { decode, encode, fontFromBytes, readIndex, rect, ellipse, toScene, writeMovie, type Scene, type SceneNode } from '../src/index.ts'
import { encodeAudio, encodeImage, encodeVideoLayer } from '../src/media.ts'
import { frameRenderer, renderVideo } from '../src/node.ts'
import { SvvSource, type ByteSource } from '../src/player.ts'

const red = { type: 'solid' as const, color: [255, 0, 0, 255] as [number, number, number, number] }
const font = fontFromBytes(readFileSync(join(import.meta.dir, '..', 'examples', 'fonts', 'bangers', 'Bangers-Regular.ttf')), 'SVV Hi')

async function pixels(scene: Scene, time = 0.5, width = 100) {
  const bytes = encode(scene)
  const back = writeMovie(decode(bytes))
  expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true)
  const r = await frameRenderer(toScene(decode(bytes)), { width })
  const data = await r.rgba(time)
  r.close()
  return (x: number, y: number) => Array.from(data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4))
}

const base = (nodes: SceneNode[], extra: Partial<Scene> = {}): Scene => ({ width: 100, height: 100, duration: 1, background: [255, 255, 255, 255], nodes, ...extra })

describe('effects', () => {
  test('alpha mask and inverted mask', async () => {
    const masked = (invert: boolean): SceneNode => ({ type: 'shape', path: rect(0, 0, 100, 100), fill: red, mask: { node: { type: 'shape', path: ellipse(50, 50, 20), fill: red }, invert } })
    const a = await pixels(base([masked(false)]))
    expect(a(50, 50)).toEqual([255, 0, 0, 255])
    expect(a(5, 5)).toEqual([255, 255, 255, 255])
    const b = await pixels(base([masked(true)]))
    expect(b(50, 50)).toEqual([255, 255, 255, 255])
    expect(b(5, 5)).toEqual([255, 0, 0, 255])
  })

  test('blend modes', async () => {
    const p = await pixels(
      base([
        { type: 'shape', path: rect(0, 0, 60, 100), fill: { type: 'solid', color: [255, 255, 0, 255] } },
        { type: 'shape', path: rect(40, 0, 60, 100), fill: { type: 'solid', color: [0, 255, 255, 255] }, blend: 'multiply' },
      ]),
    )
    expect(p(50, 50)).toEqual([0, 255, 0, 255])
    expect(p(80, 50)).toEqual([0, 255, 255, 255])
  })

  test('blur, glow and shadow', async () => {
    const square = (filters: SceneNode['filters']): SceneNode => ({ type: 'shape', path: rect(40, 40, 20, 20), fill: { type: 'solid', color: [0, 0, 0, 255] }, filters })
    const blur = await pixels(base([square([{ type: 'blur', radius: 4 }])]))
    expect(blur(36, 50)[0]!).toBeLessThan(250)
    expect(blur(50, 50)[0]!).toBeLessThan(40)
    const glow = await pixels(base([square([{ type: 'glow', radius: 4, color: [255, 0, 0, 255], strength: 2 }])]))
    expect(glow(36, 50)[0]!).toBe(255)
    expect(glow(36, 50)[1]!).toBeLessThan(250)
    expect(glow(50, 50)).toEqual([0, 0, 0, 255])
    const shadow = await pixels(base([square([{ type: 'shadow', dx: 10, dy: 10, radius: 1, color: [0, 0, 255, 255] }])]))
    expect(shadow(66, 66)[2]!).toBe(255)
    expect(shadow(66, 66)[0]!).toBeLessThan(60)
    expect(shadow(50, 50)).toEqual([0, 0, 0, 255])
  })

  test('group isolation composites opacity once', async () => {
    const group = (isolate: boolean): SceneNode => ({
      type: 'group',
      opacity: 0.5,
      isolate,
      children: [
        { type: 'shape', path: rect(0, 0, 60, 100), fill: red },
        { type: 'shape', path: rect(40, 0, 60, 100), fill: red },
      ],
    })
    const plain = await pixels(base([group(false)]))
    const iso = await pixels(base([group(true)]))
    expect(plain(50, 50)[1]!).toBeLessThan(iso(50, 50)[1]! - 30)
    expect(Math.abs(iso(50, 50)[1]! - iso(20, 50)[1]!)).toBeLessThanOrEqual(1)
  })
})

describe('text', () => {
  test('glyphs embed, survive the round trip and draw', async () => {
    const scene = base([{ type: 'text', text: 'SVV', font: 0, size: 60, align: 'center', fill: red, transform: { x: 50, y: 70 } }], { assets: [font] })
    const movie = decode(encode(scene))
    const f = movie.assets[0]!
    if (f.type !== 'font') throw new Error('expected font')
    expect(f.glyphs.map(g => g.char).sort()).toEqual([' ', 'H', 'S', 'V', 'i'])
    const p = await pixels(scene)
    let filled = 0
    for (let y = 20; y < 75; y++) for (let x = 0; x < 100; x++) if (p(x, y)[1]! < 100) filled++
    expect(filled).toBeGreaterThan(400)
    expect(p(2, 2)).toEqual([255, 255, 255, 255])
  })
})

describe('media', () => {
  test('embedded raster image', async () => {
    const rgba = new Uint8Array(4 * 4 * 4)
    for (let i = 0; i < 16; i++) rgba.set(i < 8 ? [0, 0, 255, 255] : [0, 255, 0, 255], i * 4)
    const img = await encodeImage(rgba, 4, 4, 0, 'png')
    const p = await pixels(base([{ type: 'image', asset: 0, x: 0, y: 0, width: 100, height: 100 }], { assets: [img] }))
    expect(p(50, 10)).toEqual([0, 0, 255, 255])
    expect(p(50, 90)).toEqual([0, 255, 0, 255])
  })

  test('video layer decodes per chunk', async () => {
    const w = 64
    const h = 64
    const frame = (t: number) => {
      const b = Buffer.alloc(w * h * 4)
      for (let i = 0; i < w * h; i++) b.set(t < 1 ? [220, 30, 30, 255] : [30, 30, 220, 255], i * 4)
      return b
    }
    const video = encodeVideoLayer(frame, { width: w, height: h, fps: 10, crf: 30, chunks: [[0, 1], [1, 2]] })
    expect(video.frames).toHaveLength(20)
    expect(video.frames.filter(f => f.key).map(f => f.t)).toEqual([0, 1])
    const scene = base([{ type: 'video', asset: 0, width: 100, height: 100 }], { duration: 2, assets: [video] })
    const bytes = encode(scene, { chunkDuration: 1 })
    expect(Buffer.from(writeMovie(decode(bytes))).equals(Buffer.from(bytes))).toBe(true)
    const r = await frameRenderer(toScene(decode(bytes)), { width: 50 })
    const at = async (t: number) => Array.from((await r.rgba(t)).subarray(25 * 50 * 4 + 100, 25 * 50 * 4 + 104))
    const a = await at(0.55)
    const b = await at(1.55)
    const c = await at(0.25)
    r.close()
    expect(a[0]!).toBeGreaterThan(180)
    expect(b[2]!).toBeGreaterThan(180)
    expect(c[0]!).toBeGreaterThan(180)
  })

  test('audio rides along in chunks and muxes into exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'svv-test-'))
    const wav = join(dir, 'tone.wav')
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav])
    const audio = encodeAudio(wav, [[0, 1], [1, 2]])
    const scene = base([{ type: 'shape', path: rect(0, 0, 50, 50), fill: red }], { duration: 2, assets: [audio], audio: 0 })
    const bytes = encode(scene, { chunkDuration: 1 })
    const movie = decode(bytes)
    expect(movie.audio).toBe(0)
    const a = movie.assets[0]!
    if (a.type !== 'audio') throw new Error('expected audio')
    expect(a.segments.map(s => s.t)).toEqual([0, 1])
    const out = join(dir, 'out.mp4')
    await renderVideo(toScene(movie), out, { width: 64, fps: 10 })
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout
    expect(probe).toContain('audio')
    expect(probe).toContain('video')
  })
})

describe('chunks', () => {
  const long: Scene = base(
    [
      { type: 'shape', path: rect(0, 0, 10, 10), fill: red, transform: { x: [{ t: 0, v: 0, ease: 'smooth' }, { t: 3, v: 50, ease: 'smooth' }, { t: 6, v: 20, ease: 'smooth' }, { t: 9, v: 80 }] } },
      { type: 'shape', path: rect(0, 50, 10, 10), fill: red, start: 5, end: 6 },
    ],
    { duration: 9, loop: false },
  )

  test('chunked rendering matches unchunked rendering', async () => {
    const one = toScene(decode(encode(long, { chunkDuration: 100 })))
    const many = toScene(decode(encode(long, { chunkDuration: 2 })))
    expect(decode(encode(long, { chunkDuration: 2 })).chunks).toHaveLength(5)
    const ra = await frameRenderer(one, { width: 100 })
    const rb = await frameRenderer(many, { width: 100 })
    for (const t of [0, 1.9, 2, 2.5, 4.01, 5.5, 6.7, 8.99, 9]) expect(Buffer.compare(await ra.rgba(t), await rb.rgba(t))).toBe(0)
  })

  test('a player can seek by reading only the chunk it needs', async () => {
    const bytes = encode(long, { chunkDuration: 2 })
    const reads: [number, number][] = []
    const src: ByteSource = {
      read: async (o, n) => {
        reads.push([o, n])
        return bytes.subarray(o, o + n)
      },
    }
    const source = await SvvSource.open(src)
    const index = readIndex(bytes)
    const target = source.chunkAt(7)
    expect(target).toBe(3)
    reads.length = 0
    const c = await source.chunk(target)
    expect(c.compiled.sample(7).length).toBe(1)
    const e = index.chunks[3]!
    expect(reads).toEqual([[e.offset, e.length]])
    expect(e.length).toBeLessThan(bytes.length / 3)
  })
})

describe('spline paths', () => {
  test('store points only and draw as smooth curves with corners', async () => {
    const pts: [number, number][] = [
      [20, 20],
      [80, 20],
      [80, 80],
      [20, 80],
    ]
    const spline: SceneNode = {
      type: 'shape',
      path: [{ start: pts[0]!, segments: pts.slice(1).map(to => ({ to })), closed: true, spline: true, corners: [true, false, false, false] }],
      fill: red,
    }
    const scene = base([spline])
    const back = toScene(decode(encode(scene)))
    const wrapper = back.nodes[0]!
    if (wrapper.type !== 'group' || wrapper.children[0]!.type !== 'shape') throw new Error('expected shape')
    const path = wrapper.children[0]!.path as { spline?: boolean; corners?: boolean[] }[]
    expect(path[0]!.spline).toBe(true)
    expect(path[0]!.corners).toEqual([true, false, false, false])
    const p = await pixels(scene)
    expect(p(21, 21)).toEqual([255, 0, 0, 255])
    expect(p(84, 50)).toEqual([255, 0, 0, 255])
    expect(p(97, 50)).toEqual([255, 255, 255, 255])
    expect(p(50, 50)).toEqual([255, 0, 0, 255])
  })
})
