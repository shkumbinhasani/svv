import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { AudioAsset, ImageAsset, ImageMime, VideoAsset, VideoFrame } from './model.ts'

function ffmpeg(args: string[], input?: Buffer): Buffer {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString()}`)
  return r.stdout
}

export function parseIvf(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLen = view.getUint16(6, true)
  const out: Uint8Array[] = []
  let o = headerLen
  while (o + 12 <= bytes.length) {
    const size = view.getUint32(o, true)
    out.push(bytes.slice(o + 12, o + 12 + size))
    o += 12 + size
  }
  return out
}

export const AV1_CODEC = 'av01.0.08M.08'

export interface VideoLayerOptions {
  width: number
  height: number
  fps: number
  crf: number
  preset?: number
  chunks: [number, number][]
  start?: number
}

export function encodeVideoLayer(frames: (t: number) => Buffer, opts: VideoLayerOptions): VideoAsset {
  const asset: VideoAsset = { type: 'video', codec: AV1_CODEC, width: opts.width, height: opts.height, frames: [] }
  for (const [a, b] of opts.chunks) {
    const first = Math.ceil(a * opts.fps - 1e-6)
    const last = Math.ceil(b * opts.fps - 1e-6)
    if (last <= first) continue
    const raw: Buffer[] = []
    for (let i = first; i < last; i++) raw.push(frames(i / opts.fps))
    const ivf = ffmpeg(
      [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${opts.width}x${opts.height}`,
        '-r',
        String(opts.fps),
        '-i',
        'pipe:0',
        '-c:v',
        'libsvtav1',
        '-preset',
        String(opts.preset ?? 6),
        '-crf',
        String(opts.crf),
        '-g',
        '1000',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'ivf',
        'pipe:1',
      ],
      Buffer.concat(raw),
    )
    parseIvf(ivf).forEach((data, i) => {
      const f: VideoFrame = { t: (first + i) / opts.fps, key: i === 0, data }
      asset.frames.push(f)
    })
  }
  return asset
}

export function encodeAudio(file: string, chunks: [number, number][], bitrate = '48k'): AudioAsset {
  const asset: AudioAsset = { type: 'audio', codec: 'opus', sampleRate: 48000, channels: 2, segments: [] }
  const dir = mkdtempSync(join(tmpdir(), 'svv-aud-'))
  try {
    for (const [a, b] of chunks) {
      const out = join(dir, `${a}.ogg`)
      ffmpeg(['-ss', String(a), '-t', String(b - a), '-i', file, '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', bitrate, '-f', 'ogg', out])
      asset.segments.push({ t: a, data: new Uint8Array(readFileSync(out)) })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return asset
}

export async function imageAsset(data: Uint8Array, mime: ImageMime): Promise<ImageAsset> {
  const img = await loadImage(Buffer.from(data))
  return { type: 'image', mime, width: img.width, height: img.height, data }
}

export async function encodeImage(rgba: Uint8Array, width: number, height: number, quality: number, format: 'avif' | 'webp' | 'png' = 'avif'): Promise<ImageAsset> {
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(width, height)
  img.data.set(rgba)
  ctx.putImageData(img, 0, 0)
  if (format === 'avif') {
    const dir = mkdtempSync(join(tmpdir(), 'svv-img-'))
    try {
      const png = join(dir, 'in.png')
      const out = join(dir, 'out.avif')
      writeFileSync(png, await c.encode('png'))
      ffmpeg(['-i', png, '-c:v', 'libsvtav1', '-preset', '4', '-crf', String(quality), '-pix_fmt', 'yuv420p', '-frames:v', '1', '-f', 'avif', out])
      return { type: 'image', mime: 'image/avif', width, height, data: new Uint8Array(readFileSync(out)) }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const data = format === 'webp' ? await c.encode('webp', quality) : await c.encode('png')
  return { type: 'image', mime: format === 'webp' ? 'image/webp' : 'image/png', width, height, data: new Uint8Array(data) }
}
