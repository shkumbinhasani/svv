import { spawn, spawnSync } from 'node:child_process'

export interface VideoInfo {
  width: number
  height: number
  fps: number
  frames: number
  duration: number
}

export function probe(file: string): VideoInfo {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets', '-of', 'json', file], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`)
  const s = JSON.parse(r.stdout).streams[0]
  const [num, den] = String(s.r_frame_rate).split('/').map(Number)
  const fps = num! / (den || 1)
  const frames = Number(s.nb_read_packets)
  return { width: s.width, height: s.height, fps, frames, duration: frames / fps }
}

export async function* readFrames(file: string, width: number, height: number, fps?: number): AsyncGenerator<Uint8Array> {
  const vf = [`scale=${width}:${height}:flags=area`, ...(fps ? [`fps=${fps}`] : [])].join(',')
  const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'])
  const size = width * height * 4
  let buf = new Uint8Array(size * 2)
  let len = 0
  const pending: Uint8Array[] = []
  let done = false
  let wake: (() => void) | null = null
  proc.stdout.on('data', (b: Buffer) => {
    pending.push(b)
    wake?.()
  })
  proc.stdout.on('end', () => {
    done = true
    wake?.()
  })
  try {
    for (;;) {
      while (len < size) {
        const b = pending.shift()
        if (b) {
          if (len + b.length > buf.length) {
            const next = new Uint8Array(Math.max(buf.length * 2, len + b.length))
            next.set(buf.subarray(0, len))
            buf = next
          }
          buf.set(b, len)
          len += b.length
          continue
        }
        if (done) return
        await new Promise<void>(r => (wake = r))
        wake = null
      }
      yield buf.slice(0, size)
      buf.copyWithin(0, size, len)
      len -= size
    }
  } finally {
    proc.kill()
  }
}
