import { spawn } from 'node:child_process'
import type { Canvas } from '@napi-rs/canvas'

export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export async function writeClip(file: string, width: number, height: number, fps: number, count: number, frame: (i: number) => Canvas | Buffer | Uint8Array) {
  const ff = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'bgr0', file], { stdio: ['pipe', 'inherit', 'inherit'] })
  const done = new Promise<void>((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg ${c}`)))))
  for (let i = 0; i < count; i++) {
    const f = frame(i)
    const data = 'getContext' in f ? f.getContext('2d').getImageData(0, 0, width, height).data : f
    if (!ff.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength))) await new Promise(r => ff.stdin.once('drain', r))
  }
  ff.stdin.end()
  await done
}
