import { NeedMoreData, readAsset, readChunk, readIndex, type ChunkMedia, type MovieIndex } from './codec.ts'
import { compile, sceneTimeOf, type CompiledScene } from './evaluate.ts'
import { Renderer, type Context2D, type RenderEnv, type Surface, type View } from './render.ts'
import type { Asset, AudioSegment, Scene, VideoFrame as SvvVideoFrame } from './model.ts'

export interface ByteSource {
  read(offset: number, length: number): Promise<Uint8Array>
}

export function memorySource(bytes: Uint8Array): ByteSource {
  return { read: async (o, n) => bytes.subarray(o, o + n) }
}

class ProgressiveSource implements ByteSource {
  private buf = new Uint8Array(1 << 16)
  private size = 0
  private done = false
  private error: unknown = null
  private waiters: (() => void)[] = []

  constructor(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const pump = async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (this.size + value.length > this.buf.length) {
            const next = new Uint8Array(Math.max(this.buf.length * 2, this.size + value.length))
            next.set(this.buf.subarray(0, this.size))
            this.buf = next
          }
          this.buf.set(value, this.size)
          this.size += value.length
          this.wake()
        }
      } catch (e) {
        this.error = e
      }
      this.done = true
      this.wake()
    }
    void pump()
  }

  private wake() {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    while (this.size < offset + length && !this.done) await new Promise<void>(r => this.waiters.push(r))
    if (this.error) throw this.error
    return this.buf.slice(offset, Math.min(this.size, offset + length))
  }
}

export async function urlSource(url: string | URL): Promise<ByteSource> {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-65535' } })
  if (probe.status === 206) {
    const first = new Uint8Array(await probe.arrayBuffer())
    return {
      async read(offset, length) {
        if (offset + length <= first.length) return first.subarray(offset, offset + length)
        const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } })
        if (!res.ok) throw new Error(`failed to load ${url}: ${res.status}`)
        return new Uint8Array(await res.arrayBuffer())
      },
    }
  }
  if (!probe.ok || !probe.body) throw new Error(`failed to load ${url}: ${probe.status}`)
  return new ProgressiveSource(probe.body)
}

export interface LoadedChunk {
  index: number
  start: number
  end: number
  compiled: CompiledScene
  media: ChunkMedia[]
}

export class SvvSource {
  private assets = new Map<number, Promise<Asset>>()
  private chunks = new Map<number, Promise<LoadedChunk>>()

  private constructor(
    readonly bytes: ByteSource,
    readonly index: MovieIndex,
  ) {}

  static async open(bytes: ByteSource): Promise<SvvSource> {
    let want = 4096
    for (;;) {
      const head = await bytes.read(0, want)
      try {
        return new SvvSource(bytes, readIndex(head))
      } catch (e) {
        if (!(e instanceof NeedMoreData) || head.length < want) throw e
        want = Math.max(e.needed, want * 2)
      }
    }
  }

  get movie() {
    return this.index.movie
  }

  chunkAt(sceneTime: number): number {
    const c = this.index.chunks
    let i = 0
    while (i + 1 < c.length && c[i + 1]!.start <= sceneTime) i++
    return i
  }

  asset(i: number): Promise<Asset> {
    let p = this.assets.get(i)
    if (!p) {
      const entry = this.index.entries.find(e => e.kind === 'asset' && e.asset === i)
      if (!entry) throw new Error(`asset ${i} has no data`)
      p = this.bytes.read(entry.offset, entry.length).then(b => readAsset(this.index, i, b))
      this.assets.set(i, p)
    }
    return p
  }

  chunk(i: number): Promise<LoadedChunk> {
    let p = this.chunks.get(i)
    if (!p) {
      p = this.loadChunk(i)
      this.chunks.set(i, p)
      p.catch(() => this.chunks.delete(i))
    }
    return p
  }

  forget(keep: Set<number>) {
    for (const k of this.chunks.keys()) if (!keep.has(k)) this.chunks.delete(k)
  }

  private async loadChunk(i: number): Promise<LoadedChunk> {
    const e = this.index.chunks[i]!
    const assets: Asset[] = [...this.movie.assets]
    await Promise.all(e.deps.map(async d => (assets[d] = await this.asset(d))))
    const payload = await this.bytes.read(e.offset, e.length)
    const { scene, media } = readChunk(this.index, i, payload)
    const m = this.movie
    const full: Scene = { width: m.width, height: m.height, duration: m.duration, loop: m.loop, assets, defs: scene.defs, nodes: scene.nodes }
    if (m.background) full.background = m.background
    return { index: i, start: e.start, end: e.end, compiled: compile(full), media }
  }
}

class BrowserVideo {
  private decoder: VideoDecoder | null = null
  private out: VideoFrame[] = []
  private fed = -1
  private shown: VideoFrame | null = null

  constructor(
    private codec: string,
    private width: number,
    private height: number,
    private frames: SvvVideoFrame[],
    private onFrame: () => void,
  ) {}

  private reset(from: number) {
    this.close()
    let k = from
    while (k > 0 && !this.frames[k]!.key) k--
    this.decoder = new VideoDecoder({
      output: f => {
        this.out.push(f)
        this.onFrame()
      },
      error: () => {},
    })
    this.decoder.configure({ codec: this.codec, codedWidth: this.width, codedHeight: this.height })
    this.fed = k - 1
  }

  frameAt(t: number): VideoFrame | null {
    const f = this.frames
    let i = -1
    for (let k = 0; k < f.length && f[k]!.t <= t + 1e-6; k++) i = k
    if (i < 0) return this.shown
    if (!this.decoder || i < this.fed - 8) this.reset(i)
    while (this.fed < Math.min(f.length - 1, i + 4)) {
      const fr = f[++this.fed]!
      this.decoder!.decode(new EncodedVideoChunk({ type: fr.key ? 'key' : 'delta', timestamp: Math.round(fr.t * 1e6), data: fr.data }))
    }
    const limit = t * 1e6 + 1
    while (this.out.length && this.out[0]!.timestamp <= limit) {
      this.shown?.close()
      this.shown = this.out.shift()!
    }
    return this.shown
  }

  close() {
    this.decoder?.close()
    this.decoder = null
    for (const f of this.out) f.close()
    this.out = []
    this.shown?.close()
    this.shown = null
  }
}

class BrowserEnv implements RenderEnv {
  private pool: Surface[] = []
  images = new Map<number, ImageBitmap>()
  videos = new Map<string, BrowserVideo>()
  chunk: LoadedChunk | null = null

  constructor(
    private source: SvvSource,
    private onFrame: () => void,
  ) {}

  surface(width: number, height: number): Surface {
    const s = this.pool.pop()
    if (s && (s.canvas as HTMLCanvasElement).width === width && (s.canvas as HTMLCanvasElement).height === height) return s
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height })
    return { canvas, ctx: canvas.getContext('2d') as unknown as Context2D }
  }

  release(s: Surface) {
    if (this.pool.length < 8) this.pool.push(s)
  }

  async prepare(chunk: LoadedChunk) {
    const assets = chunk.compiled.scene.assets ?? []
    await Promise.all(
      assets.map(async (a, i) => {
        if (a.type === 'image' && a.data.length && !this.images.has(i)) {
          this.images.set(i, await createImageBitmap(new Blob([a.data as BlobPart], { type: a.mime })))
        }
      }),
    )
    for (const m of chunk.media) {
      const a = this.source.movie.assets[m.asset]
      const key = `${chunk.index}:${m.asset}`
      if (a?.type === 'video' && m.frames && typeof VideoDecoder !== 'undefined' && !this.videos.has(key)) {
        this.videos.set(key, new BrowserVideo(a.codec, a.width, a.height, m.frames, this.onFrame))
      }
    }
  }

  image(asset: number) {
    return this.images.get(asset) ?? null
  }

  videoFrame(asset: number, time: number) {
    if (!this.chunk) return null
    return this.videos.get(`${this.chunk.index}:${asset}`)?.frameAt(time) ?? null
  }

  dropVideos(keep: Set<number>) {
    for (const [k, v] of this.videos) {
      if (!keep.has(Number(k.split(':')[0]))) {
        v.close()
        this.videos.delete(k)
      }
    }
  }
}

class AudioOut {
  private ctx: AudioContext | null = null
  private playing: AudioBufferSourceNode[] = []
  private scheduled = new Set<string>()

  stop() {
    for (const s of this.playing) s.stop()
    this.playing = []
    this.scheduled.clear()
  }

  async schedule(chunk: LoadedChunk, now: number) {
    if (typeof AudioContext === 'undefined') return
    this.ctx ??= new AudioContext()
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {})
    if (this.ctx.state !== 'running') return
    for (const m of chunk.media) {
      for (const [i, seg] of (m.segments ?? []).entries()) {
        const key = `${chunk.index}:${m.asset}:${i}`
        if (this.scheduled.has(key)) continue
        this.scheduled.add(key)
        void this.play(seg, now)
      }
    }
  }

  private async play(seg: AudioSegment, now: number) {
    const ctx = this.ctx!
    const startedAt = ctx.currentTime
    const buffer = await ctx.decodeAudioData(seg.data.slice().buffer as ArrayBuffer)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    const elapsed = ctx.currentTime - startedAt
    const delay = seg.t - now - elapsed
    if (delay >= 0) src.start(ctx.currentTime + delay)
    else if (-delay < buffer.duration) src.start(0, -delay)
    else return
    this.playing.push(src)
  }
}

export class SvvPlayer {
  playbackRate = 1
  fps = 0
  muted = false
  view: View | undefined
  private time = 0
  private playing = false
  private last = 0
  private raf = 0
  private ctx: Context2D
  private env: BrowserEnv
  private current: LoadedChunk | null = null
  private pending = new Set<number>()
  private audio = new AudioOut()
  private redraw = false

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly source: SvvSource,
  ) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas unavailable')
    this.ctx = ctx as unknown as Context2D
    this.env = new BrowserEnv(source, () => {
      if (!this.playing && !this.redraw) {
        this.redraw = true
        requestAnimationFrame(() => {
          this.redraw = false
          this.render()
        })
      }
    })
  }

  get duration(): number {
    return this.source.movie.duration
  }

  get currentTime(): number {
    return this.time
  }

  set currentTime(t: number) {
    this.time = t
    this.audio.stop()
    this.render()
  }

  get paused(): boolean {
    return !this.playing
  }

  play() {
    if (this.playing) return
    this.playing = true
    this.last = performance.now()
    const tick = (now: number) => {
      if (!this.playing) return
      const before = this.time
      this.time += ((now - this.last) / 1000) * this.playbackRate
      this.last = now
      const m = this.source.movie
      if (m.loop && m.duration > 0 && Math.floor(this.time / m.duration) !== Math.floor(before / m.duration)) this.audio.stop()
      if (!m.loop && this.time >= this.duration) {
        this.time = this.duration
        this.playing = false
      }
      this.render()
      if (this.playing) this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  pause() {
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.audio.stop()
  }

  resize(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1) {
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.render()
  }

  private request(i: number) {
    if (i < 0 || i >= this.source.index.chunks.length || this.pending.has(i) || this.current?.index === i) return
    this.pending.add(i)
    this.source
      .chunk(i)
      .then(async c => {
        await this.env.prepare(c)
        this.pending.delete(i)
        if (this.chunkIndex() === i) {
          this.current = c
          this.render()
        }
      })
      .catch(() => this.pending.delete(i))
  }

  private sceneTime(): number {
    const t = this.fps > 0 ? Math.floor(this.time * this.fps + 1e-9) / this.fps : this.time
    return sceneTimeOf(this.source.movie, t)
  }

  private chunkIndex(): number {
    return this.source.chunkAt(this.sceneTime())
  }

  async ready(): Promise<void> {
    const c = await this.source.chunk(this.chunkIndex())
    await this.env.prepare(c)
    this.current = c
    this.render()
  }

  render() {
    const t = this.sceneTime()
    const i = this.source.chunkAt(t)
    if (this.current?.index !== i) this.request(i)
    const chunk = this.current
    if (!chunk) return
    const n = this.source.index.chunks.length
    const live = chunk.index === i
    if (live && t > chunk.start + (chunk.end - chunk.start) / 2) this.request((i + 1) % n)
    this.env.chunk = chunk
    if (live) {
      const keep = new Set([i, (i + 1) % n])
      this.source.forget(keep)
      this.env.dropVideos(keep)
      if (this.playing && !this.muted && this.playbackRate === 1) {
        void this.audio.schedule(chunk, t)
        if (t > chunk.start + (chunk.end - chunk.start) / 2) void this.source.chunk((i + 1) % n).then(c => this.audio.schedule(c, t))
      }
    }
    new Renderer(this.env, this.canvas.width, this.canvas.height).frame(this.ctx, chunk.compiled, live ? t : Math.min(t, chunk.end - 1e-6), this.view)
  }

  destroy() {
    this.pause()
    this.env.dropVideos(new Set())
  }
}

export async function openSvv(src: string | URL): Promise<SvvSource> {
  return SvvSource.open(await urlSource(src))
}

const BaseElement = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement

export class SvvElement extends BaseElement {
  static observedAttributes = ['src', 'fps', 'playbackrate', 'view', 'muted']
  player: SvvPlayer | null = null
  private canvas: HTMLCanvasElement
  private observer: ResizeObserver
  private loading = 0

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>:host{display:block;position:relative;overflow:hidden}canvas{position:absolute;inset:0;width:100%;height:100%;display:block}</style>'
    this.canvas = document.createElement('canvas')
    root.append(this.canvas)
    this.observer = new ResizeObserver(() => this.fit())
  }

  connectedCallback() {
    this.observer.observe(this)
  }

  disconnectedCallback() {
    this.observer.disconnect()
    this.player?.destroy()
  }

  attributeChangedCallback(name: string) {
    if (name === 'src') void this.load()
    else this.applyAttributes()
  }

  private applyAttributes() {
    const p = this.player
    if (!p) return
    p.fps = Number(this.getAttribute('fps') ?? 0)
    p.playbackRate = Number(this.getAttribute('playbackrate') ?? 1)
    p.muted = this.hasAttribute('muted')
    const view = this.getAttribute('view')
    p.view = view ? (view.split(/[ ,]+/).map(Number) as View) : undefined
    p.render()
  }

  private fit() {
    this.player?.resize(this.clientWidth, this.clientHeight)
  }

  async load() {
    const src = this.getAttribute('src')
    if (!src) return
    const id = ++this.loading
    const source = await openSvv(new URL(src, document.baseURI))
    if (id !== this.loading) return
    this.player?.destroy()
    this.player = new SvvPlayer(this.canvas, source)
    const m = source.movie
    if (!this.style.aspectRatio) this.style.aspectRatio = `${m.width} / ${m.height}`
    this.applyAttributes()
    this.fit()
    await this.player.ready()
    if (this.hasAttribute('autoplay')) this.player.play()
    this.dispatchEvent(new Event('load'))
  }

  play() {
    this.player?.play()
  }

  pause() {
    this.player?.pause()
  }

  get currentTime(): number {
    return this.player?.currentTime ?? 0
  }

  set currentTime(t: number) {
    if (this.player) this.player.currentTime = t
  }

  get duration(): number {
    return this.player?.duration ?? 0
  }
}

if (globalThis.customElements && !customElements.get('svv-player')) customElements.define('svv-player', SvvElement)
