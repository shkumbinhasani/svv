import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const CLIP_DIR = join(import.meta.dir, '..', '..', 'out', 'clips')

export async function makeClips(force = false) {
  mkdirSync(CLIP_DIR, { recursive: true })
  for (const name of ['handdrawn', 'anime', 'toon3d']) {
    const file = join(CLIP_DIR, `${name}.mkv`)
    if (existsSync(file) && !force) continue
    const started = performance.now()
    await (await import(`./${name}.ts`)).make(file)
    console.log(`${name}.mkv in ${((performance.now() - started) / 1000).toFixed(0)}s`)
  }
}

if (import.meta.main) await makeClips(process.argv.includes('--force'))
