import { ellipse, rect, star, type Keyframe, type Scene, type SceneNode } from '../../src/index.ts'
import { hex, rng } from './util.ts'

const rand = rng(1234)
const colors = ['#f43f5e', '#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#ec4899']
const geoms = [rect(-12, -6, 24, 12), ellipse(0, 0, 9), star(0, 0, 14, 6, 5)]
const defs: SceneNode[] = geoms.flatMap(path => colors.map(c => ({ type: 'shape' as const, path, fill: { type: 'solid' as const, color: hex(c) } })))
const duration = 6
const top = -40
const bottom = 1120

function fallTrack(fall: number, phase: number): Keyframe<number>[] {
  const at = (t: number) => top + ((bottom - top) * (((t + phase) % fall) / fall))
  const kfs: Keyframe<number>[] = [{ t: 0, v: at(0) }]
  for (let tw = fall - phase; tw < duration; tw += fall) kfs.push({ t: tw, v: bottom }, { t: tw, v: top })
  kfs.push({ t: duration, v: at(duration) === top ? bottom : at(duration) })
  return kfs
}

const pieces: SceneNode[] = Array.from({ length: 300 }, () => {
  const x0 = rand() * 1920
  const fall = duration / (1 + Math.floor(rand() * 2))
  const phase = rand() * fall
  const sway = 20 + rand() * 60
  const turns = (rand() < 0.5 ? -1 : 1) * (1 + Math.floor(rand() * 3))
  const r0 = rand() * 360
  const q = duration / 4
  return {
    type: 'use',
    ref: Math.floor(rand() * defs.length),
    transform: {
      x: [0, sway, 0, -sway, 0].map((d, i) => ({ t: i * q, v: x0 + d, ease: 'smooth' as const })),
      y: fallTrack(fall, phase),
      rotation: [{ t: 0, v: r0 }, { t: duration, v: r0 + turns * 360 }],
      scaleX: [{ t: 0, v: 1, ease: 'smooth' }, { t: duration / 2, v: -1, ease: 'smooth' }, { t: duration, v: 1 }],
    },
  } satisfies SceneNode
})

const scene: Scene = { width: 1920, height: 1080, duration, loop: true, background: hex('#fffbeb'), defs, nodes: pieces }
export default scene
