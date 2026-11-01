import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ellipse, parseSvgPath, rect, type Keyframe, type Path, type Scene, type SceneNode } from '../../src/index.ts'
import { hex } from './util.ts'

const K = 20
const TOP = 26.69
const duration = 4
const ink = hex('#160D0A')
const skin = hex('#FDC5A8')

const svg = readFileSync(join(import.meta.dir, '..', 'art', 'anime-portrait.svg'), 'utf8').replace(/<defs>[\s\S]*?<\/defs>/, '')
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
const num = (tag: string, name: string) => Number(attr(tag, name) ?? 0)

function element(tag: string): { path: Path; fill: string; rotate?: [number, number, number] } {
  const fill = attr(tag, 'fill')!
  if (tag.startsWith('<path')) return { path: parseSvgPath(attr(tag, 'd')!), fill }
  if (tag.startsWith('<rect')) return { path: rect(0, TOP, num(tag, 'width'), num(tag, 'height')), fill }
  const r = attr(tag, 'transform')!.match(/rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)/)!
  return { path: ellipse(num(tag, 'cx'), num(tag, 'cy'), num(tag, 'rx'), num(tag, 'ry')), fill, rotate: [Number(r[1]), Number(r[2]), Number(r[3])] }
}

const art = [...svg.matchAll(/<(path|ellipse|rect)\b[^>]*\/>/g)].map(m => element(m[0]))

const PART = {
  leftWhite: 16,
  rightWhite: 17,
  star: 35,
  leftLines: [36, 37, 38],
  rightLines: [39, 40, 41],
  lineArt: 44,
  blush: [50, 51, 52, 53, 54, 55],
}

function artNode(i: number, extra: Partial<SceneNode> = {}): SceneNode {
  const e = art[i]!
  const shape: SceneNode = { type: 'shape', path: e.path, fill: { type: 'solid', color: hex(e.fill) } }
  if (!e.rotate) return { ...shape, ...extra } as SceneNode
  const [deg, cx, cy] = e.rotate
  return { type: 'group', ...extra, children: [{ ...shape, transform: { x: cx, y: cy, rotation: deg, anchor: [cx, cy] } }] } as SceneNode
}

function pulse(times: number[], low: number, high: number, width: number): Keyframe<number>[] {
  const keys: Keyframe<number>[] = [{ t: 0, v: low }]
  for (const t of times) keys.push({ t: t - width, v: low, ease: 'easeOut' }, { t, v: high, ease: 'easeIn' }, { t: t + width, v: low })
  keys.push({ t: duration, v: low })
  return keys
}

const SPARKLE = parseSvgPath('M0 -1 C0.1 -0.1 0.1 -0.1 1 0 C0.1 0.1 0.1 0.1 0 1 C-0.1 0.1 -0.1 0.1 -1 0 C-0.1 -0.1 -0.1 -0.1 0 -1Z')

function sparkle(x: number, y: number, size: number, at: number[]): SceneNode {
  const scale = pulse(at, 0, size, 0.35)
  return {
    type: 'use',
    ref: 0,
    transform: { x, y, scaleX: scale, scaleY: scale, rotation: [{ t: 0, v: 0 }, { t: duration, v: 90 }] },
  }
}

function eyelid(white: number, left: number, right: number, open: number, shut: number, sag: number, tilt: number): SceneNode {
  const lid = parseSvgPath(`M${left} -30 L${right} ${tilt - 30} L${right} ${tilt} C${right - (right - left) / 3} ${tilt + sag} ${left + (right - left) / 3} ${sag} ${left} 0Z`)
  const line = parseSvgPath(`M${right} ${tilt} C${right - (right - left) / 3} ${tilt + sag} ${left + (right - left) / 3} ${sag} ${left} 0`)
  const y: Keyframe<number>[] = [
    { t: 0, v: open, ease: 'hold' },
    { t: 2.3, v: open, ease: 'easeIn' },
    { t: 2.38, v: shut, ease: 'hold' },
    { t: 2.44, v: shut, ease: 'easeOut' },
    { t: 2.58, v: open },
  ]
  return {
    type: 'group',
    mask: { node: { type: 'shape', path: art[white]!.path, fill: { type: 'solid', color: skin }, stroke: { paint: { type: 'solid', color: skin }, width: 0.2, join: 'round' } } },
    children: [
      {
        type: 'group',
        transform: { y },
        children: [
          { type: 'shape', path: lid, fill: { type: 'solid', color: skin } },
          { type: 'shape', path: line, stroke: { paint: { type: 'solid', color: ink }, width: 0.8, cap: 'round', join: 'round' } },
        ],
      },
    ],
  }
}

function speedLine(i: number, edge: number, phase: number): SceneNode {
  const b = art[i]!.path
  const ys = [b[0]!.start[1], ...b[0]!.segments.map(s => s.to[1])]
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const s: Keyframe<number>[] = [0, 1, 2, 3, 4].map(k => ({ t: k, v: k % 2 === (phase % 2) ? 0.75 : 1.2, ease: 'smooth' as const }))
  return artNode(i, { transform: { x: edge, y: cy, anchor: [edge, cy], scaleX: s, scaleY: 1 } })
}

const shine = (base: string, at: number[]): Keyframe<[number, number, number, number]>[] => {
  const c = hex(base)
  const lit = hex('#FFF6B0')
  return [{ t: 0, v: c }, ...at.flatMap(t => [{ t: t - 0.3, v: c, ease: 'easeOut' as const }, { t, v: lit, ease: 'easeIn' as const }, { t: t + 0.4, v: c }]), { t: duration, v: c }]
}

const blush = (i: number): SceneNode => artNode(i, { opacity: [{ t: 0, v: 0.7, ease: 'smooth' }, { t: 2, v: 1, ease: 'smooth' }, { t: 4, v: 0.7 }] })

const nodes: SceneNode[] = art.map((e, i) => {
  if (PART.leftLines.includes(i)) return speedLine(i, 0, i)
  if (PART.rightLines.includes(i)) return speedLine(i, 80, i + 1)
  if (PART.blush.includes(i)) return blush(i)
  if (i === PART.star) return { type: 'shape', path: e.path, fill: { type: 'solid', color: shine(e.fill, [3.1]) } }
  return artNode(i)
})

nodes.splice(PART.lineArt + 1, 0, eyelid(PART.leftWhite, 17.5, 35, 30.5, 48.5, 3.4, -2.2), eyelid(PART.rightWhite, 44.5, 62, 29.5, 48.5, 3.6, -1.2))
nodes.push(sparkle(32.3, 35.9, 2.4, [0.6, 3.4]), sparkle(55.6, 34.8, 2.8, [1.2]), sparkle(76.6, 29.6, 2.4, [3.1]), sparkle(8.5, 31, 1.8, [1.9]))

const scene: Scene = {
  width: 80 * K,
  height: Math.round(26.71 * K),
  duration,
  defs: [{ type: 'shape', path: SPARKLE, fill: { type: 'solid', color: hex('#FFFFFF') }, filters: [{ type: 'glow', radius: 0.6, color: hex('#FFF6B0'), strength: 1.5 }] }],
  nodes: [{ type: 'group', transform: { y: -TOP * K, scaleX: K, scaleY: K }, children: nodes }],
}

export default scene
