#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { decode, encode, readIndex, toScene } from './codec.ts'
import { isKeyframes, type Scene, type SceneNode } from './model.ts'
import { renderPng, renderVideo } from './node.ts'
import { frameToSvg } from './svg.ts'
import type { View } from './render.ts'

const USAGE = `svv: Scalable Vector Video

usage:
  svv encode <scene.ts|scene.json> [-o out.svv] [--precision N] [--timescale N] [--chunk SECONDS]
  svv decode <in.svv> [-o scene.json]
  svv info <in.svv>
  svv trace <video> [-o out.svv] [--mode auto|vector|av1] [--width W] [--colors N]
            [--tolerance PX] [--plate auto|raster|none] [--chunk SECONDS]
  svv render <in.svv|scene> -o <out.mp4|webm|avif|gif|png|svg> [--width W] [--height H]
             [--fps F] [--time T] [--from T] [--to T] [--view x,y,w,h]

render works at any size and any frame rate from the same file:
  svv render clip.svv -o clip.mp4 --width 7680 --fps 240
  svv render clip.svv -o detail.png --width 4096 --view 900,500,40,40 --time 1.25`

function parse(argv: string[]) {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-o') flags.out = argv[++i]!
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]!
    else positional.push(a)
  }
  return { positional, flags }
}

async function loadScene(file: string): Promise<Scene> {
  const path = resolve(file)
  const ext = extname(path)
  if (ext === '.svv') return toScene(decode(new Uint8Array(readFileSync(path))))
  if (ext === '.json') return JSON.parse(readFileSync(path, 'utf8'))
  const mod = await import(path)
  return mod.default ?? mod.scene
}

function count(nodes: SceneNode[]): { nodes: number; keyframes: number } {
  let n = 0
  let k = 0
  const kf = (t: unknown) => (t !== undefined && isKeyframes(t as never) ? (t as unknown[]).length : 0)
  const walk = (list: SceneNode[]) => {
    for (const node of list) {
      n++
      k += kf(node.opacity)
      for (const key of ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const) k += kf(node.transform?.[key])
      if (node.type === 'group') walk(node.children)
      if (node.mask) walk([node.mask.node])
      if (node.type === 'shape') {
        k += kf(node.path)
        if (node.fill?.type === 'solid') k += kf(node.fill.color)
      }
    }
  }
  walk(nodes)
  return { nodes: n, keyframes: k }
}

const size = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { positional, flags } = parse(rest)
  const input = positional[0]
  if (!cmd || !input || cmd === 'help') {
    console.log(USAGE)
    process.exit(cmd ? 0 : 1)
  }
  if (cmd === 'encode') {
    const scene = await loadScene(input)
    const bytes = encode(scene, {
      precision: flags.precision !== undefined ? Number(flags.precision) : undefined,
      timescale: flags.timescale !== undefined ? Number(flags.timescale) : undefined,
      chunkDuration: flags.chunk !== undefined ? Number(flags.chunk) : undefined,
    })
    const out = flags.out ?? input.replace(/\.[^.]+$/, '') + '.svv'
    writeFileSync(out, bytes)
    console.log(`${out}: ${size(bytes.length)}`)
  } else if (cmd === 'decode') {
    const scene = await loadScene(input)
    const json = JSON.stringify(scene)
    if (flags.out) writeFileSync(flags.out, json)
    else console.log(json)
  } else if (cmd === 'trace') {
    const { trace } = await import('./trace/index.ts')
    const { hybrid } = await import('./trace/hybrid.ts')
    const log = (m: string) => console.error(m)
    const chunkDuration = flags.chunk !== undefined ? Number(flags.chunk) : undefined
    const result = await trace(input, {
      width: flags.width !== undefined ? Number(flags.width) : undefined,
      colors: flags.colors !== undefined ? Number(flags.colors) : undefined,
      tolerance: flags.tolerance !== undefined ? Number(flags.tolerance) : undefined,
      plate: flags.plate as 'auto' | 'raster' | 'none' | undefined,
      chunkDuration,
      log,
    })
    const { scene, chunks } = await hybrid(result, { source: input, mode: (flags.mode ?? 'auto') as 'auto' | 'vector' | 'av1', log })
    const bytes = encode(scene, { precision: -2, chunkDuration })
    const out = flags.out ?? input.replace(/\.[^.]+$/, '') + '.svv'
    writeFileSync(out, bytes)
    console.log(`${out}: ${size(bytes.length)}, ${chunks.map(c => `${c.start}-${c.end}s ${c.mode}`).join(', ')}`)
  } else if (cmd === 'info') {
    const bytes = new Uint8Array(readFileSync(input))
    const index = readIndex(bytes)
    const movie = decode(bytes)
    const m = index.movie
    const c = count(movie.chunks.flatMap(ch => [...ch.defs, ...ch.nodes]))
    const assetBytes = new Map<number, number>()
    for (const e of index.entries) if (e.kind === 'asset') assetBytes.set(e.asset, e.length)
    let mediaBytes = 0
    const lines = [
      `file:       ${input} (${size(bytes.length)})`,
      `canvas:     ${m.width} x ${m.height} units (any output resolution)`,
      `duration:   ${m.duration}s${m.loop ? ', loops' : ''} (any output frame rate)`,
      `chunks:     ${index.chunks.length} (${index.chunks.map(ch => `${ch.start}-${ch.end}s ${size(ch.length)}`).join(', ')})`,
      `nodes:      ${c.nodes} across chunks`,
      `keyframes:  ${c.keyframes}`,
    ]
    movie.assets.forEach((a, i) => {
      if (a.type === 'video') mediaBytes += a.frames.reduce((s, f) => s + f.data.length, 0)
      if (a.type === 'audio') mediaBytes += a.segments.reduce((s, f) => s + f.data.length, 0)
      const detail =
        a.type === 'font'
          ? `${a.glyphs.length} glyphs`
          : a.type === 'image'
            ? `${a.mime} ${a.width}x${a.height}`
            : a.type === 'video'
              ? `${a.codec} ${a.width}x${a.height}, ${a.frames.length} frames, ${size(a.frames.reduce((s, f) => s + f.data.length, 0))}`
              : `${a.codec} ${a.sampleRate} Hz x${a.channels}, ${a.segments.length} segments, ${size(a.segments.reduce((s, f) => s + f.data.length, 0))}`
      lines.push(`asset ${i}:    ${a.type} ${detail}${assetBytes.has(i) ? ` (${size(assetBytes.get(i)!)})` : ''}`)
    })
    lines.push(`media:      ${size(mediaBytes)} of video/audio inside chunks`)
    lines.push(`bitrate:    ${((bytes.length * 8) / Math.max(m.duration, 1e-9) / 1000).toFixed(2)} kbit/s`)
    console.log(lines.join('\n'))
  } else if (cmd === 'render') {
    const scene = await loadScene(input)
    const out = flags.out
    if (!out) throw new Error('render needs -o <file>')
    const width = Number(flags.width ?? scene.width)
    const height = flags.height !== undefined ? Number(flags.height) : undefined
    const view = flags.view ? (flags.view.split(',').map(Number) as View) : undefined
    const time = Number(flags.time ?? 0)
    if (out.endsWith('.png')) writeFileSync(out, await renderPng(scene, time, { width, height, view }))
    else if (out.endsWith('.svg')) writeFileSync(out, frameToSvg(scene, time))
    else {
      const fps = Number(flags.fps ?? 30)
      await renderVideo(scene, out, {
        width,
        height,
        view,
        fps,
        from: flags.from !== undefined ? Number(flags.from) : undefined,
        to: flags.to !== undefined ? Number(flags.to) : undefined,
      })
    }
    console.log(out)
  } else {
    console.log(USAGE)
    process.exit(1)
  }
}

main().catch(e => {
  console.error(`svv: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
