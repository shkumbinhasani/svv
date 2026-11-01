import { expect, test } from 'bun:test'
import { createCanvas } from '@napi-rs/canvas'
import { encode, rect, type Scene } from '../src/index.ts'
import { memorySource, SvvPlayer, SvvSource } from '../src/player.ts'

test('a paused player past the middle of its only chunk draws once per seek', async () => {
  const scene: Scene = {
    width: 100,
    height: 100,
    duration: 2,
    nodes: [{ type: 'shape', path: rect(0, 0, 50, 50), fill: { type: 'solid', color: [255, 0, 0, 255] } }],
  }
  const source = await SvvSource.open(memorySource(encode(scene)))
  expect(source.index.chunks.length).toBe(1)
  const player = new SvvPlayer(createCanvas(100, 100) as unknown as HTMLCanvasElement, source)
  await player.ready()
  let draws = 0
  const render = player.render.bind(player)
  player.render = () => {
    draws++
    render()
  }
  player.currentTime = 1.5
  await new Promise(r => setTimeout(r, 50))
  expect(draws).toBe(1)
})
