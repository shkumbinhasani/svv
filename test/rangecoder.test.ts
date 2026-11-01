import { expect, test } from 'bun:test'
import { BitReader, BitWriter } from '../src/rangecoder.ts'

test('round-trips mixed values', () => {
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const ops: [string, number][] = []
  for (let i = 0; i < 20000; i++) {
    const kind = Math.floor(rand() * 5)
    if (kind === 0) ops.push(['bit', rand() < 0.9 ? 1 : 0])
    else if (kind === 1) ops.push(['uint', Math.floor(rand() ** 4 * 2 ** (rand() * 32))])
    else if (kind === 2) ops.push(['sint', Math.round((rand() - 0.5) * 2 ** (rand() * 30)) || 0])
    else if (kind === 3) ops.push(['sym', Math.floor(rand() * 256)])
    else ops.push(['raw', Math.floor(rand() * 2 ** 20)])
  }
  const w = new BitWriter()
  for (const [k, v] of ops) {
    if (k === 'bit') w.bit('b', v === 1)
    else if (k === 'uint') w.uint('u', v)
    else if (k === 'sint') w.sint('s', v)
    else if (k === 'sym') w.symbol('y', v, 8)
    else w.raw(v, 20)
  }
  const bytes = w.finish()
  const r = new BitReader(bytes)
  for (const [k, v] of ops) {
    const got = k === 'bit' ? (r.bit('b') ? 1 : 0) : k === 'uint' ? r.uint('u') : k === 'sint' ? r.sint('s') : k === 'sym' ? r.symbol('y', 8) : r.raw(20)
    expect(got).toBe(v)
  }
})

test('skewed bits compress well', () => {
  const w = new BitWriter()
  for (let i = 0; i < 80000; i++) w.bit('b', i % 100 === 0)
  expect(w.finish().length).toBeLessThan(1000)
})
