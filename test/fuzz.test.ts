import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { compile, decode, encode, toScene, type Scene } from '../src/index.ts'

test('corrupted files never hang or crash the process', async () => {
  const scene: Scene = (await import(join(import.meta.dir, '..', 'examples', 'scenes', 'morph.ts'))).default
  const good = encode(scene)
  let seed = 99
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  let rejected = 0
  const started = performance.now()
  for (let i = 0; i < 300; i++) {
    const bad = good.slice(0, 4 + Math.floor(rand() * (good.length - 4)) + 1)
    const flips = 1 + Math.floor(rand() * 4)
    for (let f = 0; f < flips; f++) bad[4 + Math.floor(rand() * (bad.length - 4))] ^= 1 << Math.floor(rand() * 8)
    try {
      compile(toScene(decode(bad))).sample(rand() * 6)
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      rejected++
    }
  }
  expect(rejected).toBeGreaterThan(200)
  expect(performance.now() - started).toBeLessThan(20000)
})
