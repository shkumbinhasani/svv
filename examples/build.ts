import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { encode } from '../src/index.ts'

const dir = import.meta.dir
const out = join(dir, 'svv')
mkdirSync(out, { recursive: true })
const manifest: { name: string; bytes: number; duration: number }[] = []
for (const file of readdirSync(join(dir, 'scenes')).filter(f => f.endsWith('.ts') && f !== 'util.ts').sort()) {
  const name = file.replace(/\.ts$/, '')
  const scene = (await import(join(dir, 'scenes', file))).default
  const bytes = encode(scene)
  writeFileSync(join(out, `${name}.svv`), bytes)
  manifest.push({ name, bytes: bytes.length, duration: scene.duration })
  console.log(`${name}.svv  ${bytes.length} bytes`)
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const build = await Bun.build({ entrypoints: [join(dir, '..', 'src', 'player.ts')], outdir: dir, naming: 'svv-player.js', minify: true, target: 'browser' })
if (!build.success) throw new AggregateError(build.logs, 'player build failed')
console.log(`svv-player.js  ${build.outputs[0]!.size} bytes`)
