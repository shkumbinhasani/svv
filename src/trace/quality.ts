import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseIvf } from '../media.ts'

function ffmpeg(args: string[]): string {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-2000)}`)
  return r.stderr
}

const trim = (start: number, count: number) => `trim=start_frame=${start}:end_frame=${start + count},`
const index = 'settb=1/1000,setpts=N*40,'

export type Size = [number, number]

const scale = (size?: Size) => (size ? `scale=${size[0]}:${size[1]}:flags=area,` : '')

export function ssim(distorted: string, reference: string, refStart = 0, count?: number, size?: Size): number {
  const t = (count === undefined ? '' : trim(refStart, count)) + scale(size)
  const log = ffmpeg(['-i', distorted, '-i', reference, '-lavfi', `[0:v]${index}format=yuv420p[a];[1:v]${t}${index}format=yuv420p[b];[a][b]ssim`, '-f', 'null', '-'])
  const m = log.match(/All:([\d.]+)/)
  if (!m) throw new Error('ssim not found')
  return Number(m[1])
}

export function psnr(distorted: string, reference: string): number {
  const log = ffmpeg(['-i', distorted, '-i', reference, '-lavfi', `[0:v]${index}format=yuv420p[a];[1:v]${index}format=yuv420p[b];[a][b]psnr`, '-f', 'null', '-'])
  const m = log.match(/average:([\d.inf]+)/)
  return m ? Number(m[1]) : NaN
}

export interface Av1Result {
  crf: number
  ssim: number
  bytes: number
  frames: Uint8Array[]
}

export const AV1_ARGS = (crf: number, preset: number, gop: number) => ['-c:v', 'libsvtav1', '-preset', String(preset), '-crf', String(crf), '-g', String(gop), '-pix_fmt', 'yuv420p']

export function av1(source: string, start: number, count: number, crf: number, preset = 4, size?: Size): Av1Result {
  const dir = mkdtempSync(join(tmpdir(), 'svv-av1-'))
  try {
    const ivf = join(dir, 'out.ivf')
    ffmpeg(['-loglevel', 'error', '-i', source, '-vf', `${trim(start, count)}setpts=PTS-STARTPTS,${scale(size)}format=yuv420p`, ...AV1_ARGS(crf, preset, count + 1), '-f', 'ivf', ivf])
    const bytes = new Uint8Array(readFileSync(ivf))
    const frames = parseIvf(bytes)
    return { crf, ssim: ssim(ivf, source, start, count, size), bytes: frames.reduce((s, f) => s + f.length, 0), frames }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function av1AtSsim(source: string, start: number, count: number, target: number, preset = 4, size?: Size): Av1Result | null {
  let lo = 1
  let hi = 63
  let best: Av1Result | null = null
  const top = av1(source, start, count, lo, preset, size)
  if (top.ssim < target) return null
  best = top
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const r = av1(source, start, count, mid, preset, size)
    if (r.ssim >= target) {
      best = r
      lo = mid
    } else hi = mid - 1
  }
  return best
}
