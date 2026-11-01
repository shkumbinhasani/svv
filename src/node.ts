import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, toScene } from './codec.ts'
import { compile, type CompiledScene } from './evaluate.ts'
import { Renderer, type Context2D, type RenderEnv, type Surface, type View } from './render.ts'
import type { Scene, VideoAsset } from './model.ts'

export function loadScene(bytes: Uint8Array): Scene {
  return toScene(decode(bytes))
}

export interface FrameOptions {
  width: number
  height?: number
  view?: View
}

function size(scene: Scene, opts: FrameOptions): [number, number] {
  const [, , vw, vh] = opts.view ?? [0, 0, scene.width, scene.height]
  const w = Math.round(opts.width)
  const h = opts.height ?? Math.round((w * vh) / vw)
  return [w, h]
}

export function ivf(frames: { data: Uint8Array }[], width: number, height: number): Buffer {
  const head = Buffer.alloc(32)
  head.write('DKIF', 0)
  head.writeUInt16LE(0, 4)
  head.writeUInt16LE(32, 6)
  head.write('AV01', 8)
  head.writeUInt16LE(width, 12)
  head.writeUInt16LE(height, 14)
  head.writeUInt32LE(1000, 16)
  head.writeUInt32LE(1, 20)
  head.writeUInt32LE(frames.length, 24)
  const parts: Buffer[] = [head]
  frames.forEach((f, i) => {
    const fh = Buffer.alloc(12)
    fh.writeUInt32LE(f.data.length, 0)
    fh.writeBigUInt64LE(BigInt(i), 4)
    parts.push(fh, Buffer.from(f.data))
  })
  return Buffer.concat(parts)
}

class ByteQueue {
  private chunks: Buffer[] = []
  private length = 0
  private waiting: { n: number; resolve: (b: Buffer | null) => void } | null = null
  private ended = false

  push(b: Buffer) {
    this.chunks.push(b)
    this.length += b.length
    this.wake()
  }

  end() {
    this.ended = true
    this.wake()
  }

  private wake() {
    const w = this.waiting
    if (!w) return
    if (this.length >= w.n) {
      this.waiting = null
      w.resolve(this.take(w.n))
    } else if (this.ended) {
      this.waiting = null
      w.resolve(null)
    }
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks)
    this.chunks = [all.subarray(n)]
    this.length -= n
    return all.subarray(0, n)
  }

  read(n: number): Promise<Buffer | null> {
    if (this.length >= n) return Promise.resolve(this.take(n))
    if (this.ended) return Promise.resolve(null)
    return new Promise(resolve => {
      this.waiting = { n, resolve }
    })
  }
}

class NodeVideo {
  private proc: ChildProcessWithoutNullStreams | null = null
  private queue: ByteQueue | null = null
  private next = -1
  private shown = -1
  readonly canvas: Canvas

  constructor(private asset: VideoAsset) {
    this.canvas = createCanvas(asset.width, asset.height)
  }

  private index(t: number): number {
    const f = this.asset.frames
    let lo = 0
    let hi = f.length - 1
    if (hi < 0 || t < f[0]!.t) return -1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (f[mid]!.t <= t + 1e-9) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private restart(from: number) {
    this.stop()
    let k = from
    while (k > 0 && !this.asset.frames[k]!.key) k--
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'ivf', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'])
    const queue = new ByteQueue()
    proc.stdout.on('data', (b: Buffer) => queue.push(b))
    proc.stdout.on('end', () => queue.end())
    proc.stdin.on('error', () => {})
    proc.stdin.end(ivf(this.asset.frames.slice(k), this.asset.width, this.asset.height))
    this.proc = proc
    this.queue = queue
    this.next = k
  }

  stop() {
    this.proc?.kill()
    this.proc = null
    this.queue = null
  }

  async prepare(t: number) {
    const i = this.index(t)
    if (i < 0 || i === this.shown) return
    if (!this.queue || i < this.next || i - this.next > 120) this.restart(i)
    const bytes = this.asset.width * this.asset.height * 4
    let frame: Buffer | null = null
    while (this.next <= i) {
      frame = await this.queue!.read(bytes)
      if (!frame) throw new Error('video layer ended early')
      this.next++
    }
    const ctx = this.canvas.getContext('2d')
    const img = ctx.createImageData(this.asset.width, this.asset.height)
    img.data.set(frame!)
    ctx.putImageData(img, 0, 0)
    this.shown = i
  }
}

export class NodeEnv implements RenderEnv {
  private pool: Surface[] = []
  private images = new Map<number, Image>()
  private videos = new Map<number, NodeVideo>()

  constructor(private scene: Scene) {}

  async load() {
    const assets = this.scene.assets ?? []
    await Promise.all(
      assets.map(async (a, i) => {
        if (a.type === 'image') this.images.set(i, await loadImage(Buffer.from(a.data)))
        if (a.type === 'video') this.videos.set(i, new NodeVideo(a))
      }),
    )
  }

  async prepare(time: number) {
    for (const v of this.videos.values()) await v.prepare(time)
  }

  surface(width: number, height: number): Surface {
    const s = this.pool.pop()
    if (s && (s.canvas as Canvas).width === width && (s.canvas as Canvas).height === height) return s
    const canvas = createCanvas(width, height)
    return { canvas, ctx: canvas.getContext('2d') as unknown as Context2D }
  }

  release(s: Surface) {
    this.pool.push(s)
  }

  image(asset: number) {
    return this.images.get(asset) ?? null
  }

  videoFrame(asset: number) {
    return this.videos.get(asset)?.canvas ?? null
  }

  close() {
    for (const v of this.videos.values()) v.stop()
  }
}

export async function frameRenderer(scene: Scene | CompiledScene, opts: FrameOptions) {
  const compiled = 'sample' in scene ? scene : compile(scene)
  const [width, height] = size(compiled.scene, opts)
  const env = new NodeEnv(compiled.scene)
  await env.load()
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as Context2D
  const renderer = new Renderer(env, width, height)
  return {
    width,
    height,
    canvas,
    env,
    async draw(time: number) {
      await env.prepare(compiled.sceneTime(time))
      renderer.frame(ctx, compiled, time, opts.view)
      return canvas
    },
    async rgba(time: number): Promise<Buffer> {
      await this.draw(time)
      const data = canvas.getContext('2d').getImageData(0, 0, width, height).data
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    },
    close() {
      env.close()
    },
  }
}

export async function renderPng(scene: Scene, time: number, opts: FrameOptions): Promise<Buffer> {
  const r = await frameRenderer(scene, opts)
  try {
    return (await r.draw(time)).encode('png')
  } finally {
    r.close()
  }
}

export interface VideoOptions extends FrameOptions {
  fps: number
  from?: number
  to?: number
  ffmpegArgs?: string[]
  audio?: boolean
}

export function frameTimes(scene: Scene, fps: number, from = 0, to = scene.duration): number[] {
  const count = Math.max(1, Math.round((to - from) * fps))
  return Array.from({ length: count }, (_, i) => from + i / fps)
}

export async function renderVideo(scene: Scene, out: string, opts: VideoOptions): Promise<void> {
  const r = await frameRenderer(scene, opts)
  const from = opts.from ?? 0
  const to = opts.to ?? scene.duration
  const audio = opts.audio !== false && scene.audio !== undefined && !/\.(gif|avif|png)$/.test(out) ? scene.assets?.[scene.audio] : undefined
  const tmp = audio?.type === 'audio' ? mkdtempSync(join(tmpdir(), 'svv-audio-')) : null
  const audioInputs: string[] = []
  const filters: string[] = []
  if (tmp && audio?.type === 'audio') {
    audio.segments.forEach((s, i) => {
      const file = join(tmp, `${i}.ogg`)
      writeFileSync(file, s.data)
      audioInputs.push('-i', file)
      filters.push(`[${i + 1}:a]adelay=${Math.max(0, Math.round((s.t - from) * 1000))}:all=1[a${i}]`)
    })
    filters.push(`${audio.segments.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.segments.length}:normalize=0,atrim=0:${to - from}[aout]`)
  }
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${r.width}x${r.height}`,
    '-r',
    String(opts.fps),
    '-i',
    '-',
    ...audioInputs,
    ...(audioInputs.length ? ['-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', out.endsWith('.webm') ? 'libopus' : 'aac'] : []),
    ...(opts.ffmpegArgs ?? defaultArgs(out)),
    out,
  ]
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise<void>((resolve, reject) => {
    ff.on('error', reject)
    ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))))
  })
  try {
    for (const t of frameTimes(scene, opts.fps, from, to)) {
      if (!ff.stdin.write(await r.rgba(t))) await new Promise(res => ff.stdin.once('drain', res))
    }
    ff.stdin.end()
    await done
  } finally {
    r.close()
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

function defaultArgs(out: string): string[] {
  if (out.endsWith('.avif')) return ['-c:v', 'libsvtav1', '-preset', '6', '-crf', '35', '-pix_fmt', 'yuv420p']
  if (out.endsWith('.webm')) return ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p']
  if (out.endsWith('.gif')) return ['-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse']
  if (out.endsWith('.mkv')) return ['-c:v', 'ffv1', '-pix_fmt', 'yuv420p']
  return ['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']
}
