import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decode, encode, toScene, type Scene } from '../src/index.ts'
import { ivf, renderVideo } from '../src/node.ts'
import { hybrid, type ChunkChoice } from '../src/trace/hybrid.ts'
import { trace } from '../src/trace/index.ts'
import { av1, av1AtSsim, psnr, ssim, type Av1Result } from '../src/trace/quality.ts'
import { CLIP_DIR, makeClips } from './clips/make.ts'

const root = join(import.meta.dir, '..')
const work = join(root, 'out', 'bench')
mkdirSync(work, { recursive: true })
const WIDTH = 1280
const HEIGHT = 720
const FPS = 24
const lossless = ['-c:v', 'ffv1', '-pix_fmt', 'bgr0']

interface Clip {
  key: string
  label: string
  scene?: string
  file?: string
}

const clips: Clip[] = [
  { key: 'titles', label: 'Motion graphics', scene: 'titles' },
  { key: 'cutout', label: 'Rigged cut-out character', scene: 'cutout' },
  { key: 'handdrawn', label: 'Hand-drawn frame by frame', file: 'handdrawn.mkv' },
  { key: 'anime', label: 'Anime style, painted background', file: 'anime.mkv' },
  { key: 'toon3d', label: '3D-rendered toon', file: 'toon3d.mkv' },
]

function avifBytes(r: Av1Result, name: string): number {
  const src = join(work, `${name}.ivf`)
  const out = join(work, `${name}.avif`)
  writeFileSync(src, ivf(r.frames.map(data => ({ data })), WIDTH, HEIGHT))
  const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-r', String(FPS), '-i', src, '-c', 'copy', '-f', 'avif', out])
  if (res.status !== 0) throw new Error(res.stderr.toString())
  return statSync(out).size
}

function frames(file: string): number {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  return Number(r.stdout.trim())
}

interface Row {
  clip: string
  label: string
  source: 'vector' | 'raster'
  svvBytes: number
  svvSsim: number
  svvPsnr: number
  avifBytes: number | null
  avifSsim: number | null
  avifCrf: number | null
  avifMaxQuality?: { bytes: number; ssim: number }
  avifMinSize?: { bytes: number; ssim: number }
  chunks?: ChunkChoice[]
  traceSeconds?: number
}

const only = process.argv.slice(2).filter(a => !a.startsWith('--'))
await makeClips()
const rows: Row[] = []
for (const clip of clips) {
  if (only.length && !only.includes(clip.key)) continue
  console.log(`\n== ${clip.label}`)
  let source: string
  let svv: Uint8Array
  let row: Partial<Row>
  if (clip.scene) {
    const scene: Scene = (await import(join(root, 'examples', 'scenes', `${clip.scene}.ts`))).default
    source = join(work, `${clip.key}-source.mkv`)
    if (!existsSync(source)) await renderVideo(scene, source, { width: WIDTH, height: HEIGHT, fps: FPS, ffmpegArgs: lossless })
    svv = encode(scene)
    row = { source: 'vector' }
  } else {
    source = join(CLIP_DIR, clip.file!)
    const started = performance.now()
    const traced = await trace(source, { log: m => console.log(`  ${m}`) })
    const { scene, chunks } = await hybrid(traced, { source, log: m => console.log(`  ${m}`) })
    svv = encode(scene, { precision: -2 })
    row = { source: 'raster', chunks, traceSeconds: (performance.now() - started) / 1000 }
  }
  writeFileSync(join(work, `${clip.key}.svv`), svv)
  const rendered = join(work, `${clip.key}-svv.mkv`)
  await renderVideo(toScene(decode(svv)), rendered, { width: WIDTH, height: HEIGHT, fps: FPS, ffmpegArgs: lossless })
  const svvSsim = ssim(rendered, source)
  const svvPsnr = psnr(rendered, source)
  const count = frames(source)
  const matched = av1AtSsim(source, 0, count, svvSsim)
  const full: Row = {
    clip: clip.key,
    label: clip.label,
    source: row.source!,
    svvBytes: svv.length,
    svvSsim,
    svvPsnr,
    avifBytes: matched ? avifBytes(matched, `${clip.key}-matched`) : null,
    avifSsim: matched?.ssim ?? null,
    avifCrf: matched?.crf ?? null,
    ...row,
  }
  if (!matched) {
    const best = av1(source, 0, count, 1)
    const small = av1(source, 0, count, 63)
    full.avifMaxQuality = { bytes: avifBytes(best, `${clip.key}-crf1`), ssim: best.ssim }
    full.avifMinSize = { bytes: avifBytes(small, `${clip.key}-crf63`), ssim: small.ssim }
  }
  rows.push(full)
  console.log(JSON.stringify(full, (k, v) => (k === 'chunks' ? v.map((c: ChunkChoice) => `${c.mode} vec ${c.vectorBytes}B/${c.vectorSsim.toFixed(4)} av1 ${c.av1Bytes}B/${c.av1Ssim?.toFixed(4)}`) : v)))
}

const previous: Row[] = existsSync(join(work, 'results.json')) ? JSON.parse(await Bun.file(join(work, 'results.json')).text()) : []
for (const r of previous) if (!rows.some(x => x.clip === r.clip)) rows.push(r)
rows.sort((a, b) => clips.findIndex(c => c.key === a.clip) - clips.findIndex(c => c.key === b.clip))
writeFileSync(join(work, 'results.json'), JSON.stringify(rows, null, 2))
const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`
const lines = [
  '| Clip | Source | SVV | SVV SSIM | AVIF at same SSIM | AVIF / SVV |',
  '|---|---|---:|---:|---:|---:|',
  ...rows.map(r => {
    const avif = r.avifBytes ?? r.avifMinSize!.bytes
    const note = r.avifBytes === null ? ` (no CRF reaches it; CRF 63 shown, SSIM ${r.avifMinSize!.ssim.toFixed(4)})` : ` (CRF ${r.avifCrf}, SSIM ${r.avifSsim!.toFixed(4)})`
    return `| ${r.label} | ${r.source} | ${kb(r.svvBytes)} | ${r.svvSsim.toFixed(4)} | ${kb(avif)}${note} | ${(avif / r.svvBytes).toFixed(2)}× |`
  }),
]
writeFileSync(join(work, 'results.md'), lines.join('\n') + '\n')
console.log('\n' + lines.join('\n'))
