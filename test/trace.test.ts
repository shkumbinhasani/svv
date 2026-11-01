import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode, ellipse, rect, toScene, type Scene } from '../src/index.ts'
import { renderVideo } from '../src/node.ts'
import { hybrid } from '../src/trace/hybrid.ts'
import { trace } from '../src/trace/index.ts'
import { ssim } from '../src/trace/quality.ts'

const source: Scene = {
  width: 320,
  height: 180,
  duration: 2,
  loop: false,
  background: [240, 236, 220, 255],
  nodes: [
    { type: 'shape', path: rect(0, 140, 320, 40), fill: { type: 'solid', color: [120, 160, 90, 255] } },
    { type: 'shape', path: ellipse(0, 0, 24), fill: { type: 'solid', color: [220, 80, 60, 255] }, transform: { x: [{ t: 0, v: 40 }, { t: 2, v: 280 }], y: 100 } },
    { type: 'shape', path: rect(-20, -20, 40, 40, 6), fill: { type: 'solid', color: [60, 90, 200, 255] }, transform: { x: 160, y: 60, rotation: [{ t: 0, v: 0 }, { t: 2, v: 90 }] } },
  ],
}

test('tracing a video links shapes across frames and reproduces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svv-trace-'))
  const file = join(dir, 'src.mkv')
  await renderVideo(source, file, { width: 320, fps: 24, ffmpegArgs: ['-c:v', 'ffv1', '-pix_fmt', 'bgr0'] })
  const result = await trace(file)
  expect(result.frames).toBe(48)
  expect(result.stats.linked).toBeGreaterThan(result.stats.created * 2)
  expect(result.stats.keyframes).toBeLessThan(result.stats.drawings * result.stats.nodes)
  const bytes = encode(result.scene, { precision: -2 })
  const out = join(dir, 'traced.mkv')
  await renderVideo(toScene(decode(bytes)), out, { width: 320, fps: 24, ffmpegArgs: ['-c:v', 'ffv1', '-pix_fmt', 'bgr0'] })
  expect(ssim(out, file)).toBeGreaterThan(0.98)
}, 120000)

test('hybrid mode keeps the smaller of vector and AV1 per chunk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svv-hybrid-'))
  const file = join(dir, 'src.mkv')
  await renderVideo(source, file, { width: 320, fps: 24, ffmpegArgs: ['-c:v', 'ffv1', '-pix_fmt', 'bgr0'] })
  const result = await trace(file)
  const { scene, chunks } = await hybrid(result, { source: file })
  expect(chunks).toHaveLength(1)
  const c = chunks[0]!
  expect(c.mode).toBe(c.av1Bytes !== null && c.av1Bytes < c.vectorBytes ? 'av1' : 'vector')
  const forced = await hybrid(result, { source: file, mode: 'av1' })
  expect(forced.chunks[0]!.mode).toBe('av1')
  const movie = decode(encode(forced.scene))
  expect(movie.assets.some(a => a.type === 'video' && a.frames.length === 48)).toBe(true)
  expect(scene.nodes.length).toBeGreaterThan(0)
}, 300000)
