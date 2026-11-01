import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '../codec.ts'
import { AV1_CODEC } from '../media.ts'
import type { Scene, SceneNode, VideoAsset } from '../model.ts'
import { renderVideo } from '../node.ts'
import type { TraceResult } from './index.ts'
import { av1AtSsim, ssim } from './quality.ts'

export interface ChunkChoice {
  start: number
  end: number
  mode: 'vector' | 'av1'
  vectorBytes: number
  vectorSsim: number
  av1Bytes: number | null
  av1Ssim: number | null
  crf: number | null
}

export interface HybridOptions {
  source: string
  mode?: 'auto' | 'vector' | 'av1'
  precision?: number
  minSsim?: number
  log?: (m: string) => void
}

export async function hybrid(result: TraceResult, opts: HybridOptions): Promise<{ scene: Scene; chunks: ChunkChoice[] }> {
  const log = opts.log ?? (() => {})
  const mode = opts.mode ?? 'auto'
  const { scene, fps } = result
  const size: [number, number] = [result.width, result.height]
  const groups = scene.nodes.filter((n): n is Extract<SceneNode, { type: 'group' }> => n.type === 'group')
  const shared = scene.nodes.filter(n => n.type !== 'group')
  const dir = mkdtempSync(join(tmpdir(), 'svv-hybrid-'))
  const video: VideoAsset = { type: 'video', codec: AV1_CODEC, width: result.width, height: result.height, frames: [] }
  const out: SceneNode[] = []
  const chunks: ChunkChoice[] = []
  let usesShared = false
  try {
    for (const [i, g] of groups.entries()) {
      const start = g.start ?? 0
      const end = g.end ?? scene.duration
      const first = Math.round(start * fps)
      const count = Math.round(end * fps) - first
      const only: Scene = { ...scene, duration: scene.duration, nodes: [...shared, g] }
      const vectorBytes = encode(only, { precision: opts.precision ?? -2 }).length
      let vectorSsim = 1
      if (mode !== 'vector') {
        const file = join(dir, `chunk${i}.mkv`)
        await renderVideo(only, file, { width: result.width, height: result.height, fps, from: start, to: start + count / fps, ffmpegArgs: ['-c:v', 'ffv1', '-pix_fmt', 'bgr0'] })
        vectorSsim = ssim(file, opts.source, first, count, size)
      }
      const floor = opts.minSsim ?? 0.97
      const vectorOk = vectorSsim >= floor
      const alt = mode === 'vector' ? null : av1AtSsim(opts.source, first, count, mode === 'av1' ? floor : Math.max(vectorSsim, floor), 4, size)
      const useAv1 = !!alt && (mode === 'av1' || !vectorOk || alt.bytes < vectorBytes)
      chunks.push({ start, end, mode: useAv1 ? 'av1' : 'vector', vectorBytes, vectorSsim, av1Bytes: alt?.bytes ?? null, av1Ssim: alt?.ssim ?? null, crf: alt?.crf ?? null })
      log(`chunk ${start}-${end}s: vector ${vectorBytes} B at SSIM ${vectorSsim.toFixed(4)}; AV1 ${alt ? `${alt.bytes} B at SSIM ${alt.ssim.toFixed(4)} (crf ${alt.crf})` : 'cannot reach that SSIM'} -> ${useAv1 ? 'AV1' : 'vector'}${vectorOk ? '' : ` (vector below the SSIM floor ${floor})`}`)
      if (useAv1) {
        alt.frames.forEach((data, k) => video.frames.push({ t: (first + k) / fps, key: k === 0, data }))
        const v: SceneNode = { type: 'video', asset: -1, width: result.width, height: result.height }
        const wrap: SceneNode = { type: 'group', children: [v] }
        if (g.start !== undefined) wrap.start = g.start
        if (g.end !== undefined) wrap.end = g.end
        out.push(wrap)
      } else {
        usesShared = true
        out.push(g)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const assets = usesShared ? [...(scene.assets ?? [])] : []
  const nodes: SceneNode[] = usesShared ? [...shared] : []
  if (video.frames.length) {
    const vi = assets.length
    assets.push(video)
    for (const n of out) if (n.type === 'group' && n.children[0]?.type === 'video') n.children[0].asset = vi
  }
  nodes.push(...out)
  const final: Scene = { ...scene, nodes }
  if (assets.length) final.assets = assets
  else delete final.assets
  return { scene: final, chunks }
}
