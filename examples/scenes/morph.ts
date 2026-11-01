import { ellipse, rect, regularPolygon, star, type Color, type Keyframe, type Path, type Scene, type SceneNode } from '../../src/index.ts'
import { hex } from './util.ts'

const cx = 960
const cy = 470
const shapes: Path[] = [
  ellipse(cx, cy, 210),
  star(cx, cy, 250, 110, 5),
  rect(cx - 190, cy - 190, 380, 380, 60),
  regularPolygon(cx, cy, 240, 6),
  star(cx, cy, 240, 170, 12),
  ellipse(cx, cy, 210),
]
const colors: Color[] = ['#6366f1', '#f43f5e', '#f59e0b', '#10b981', '#0ea5e9', '#6366f1'].map(c => hex(c))
const step = 1.2

const morph: Keyframe<Path>[] = shapes.flatMap((v, i) => {
  const t = i * step
  return i < shapes.length - 1 ? [{ t, v, ease: 'easeInOut' as const }, { t: t + 0.35, v, ease: 'easeInOut' as const }] : [{ t, v }]
})
const fills: Keyframe<Color>[] = colors.flatMap((v, i) => {
  const t = i * step
  return i < colors.length - 1 ? [{ t, v, ease: 'easeInOut' as const }, { t: t + 0.35, v, ease: 'easeInOut' as const }] : [{ t, v }]
})

const duration = step * (shapes.length - 1)
const ballColors = ['#6366f1', '#f43f5e', '#f59e0b', '#10b981', '#0ea5e9', '#a855f7', '#ec4899']
const floor = 1000
const balls: SceneNode[] = ballColors.map((c, i) => {
  const x = 330 + i * 210
  const period = duration / 3
  const offset = (i / ballColors.length) * period
  const ys: Keyframe<number>[] = []
  const squash: Keyframe<number>[] = []
  for (let k = -1; k <= 3; k++) {
    const t0 = offset + k * period
    ys.push({ t: t0, v: floor - 40, ease: [0.33, 0, 0.66, 0] }, { t: t0 + 0.06, v: floor - 40, ease: [0.33, 1, 0.66, 1] }, { t: t0 + period / 2, v: 720 - i * 12, ease: [0.33, 0, 0.66, 0] })
    squash.push({ t: t0 - 0.04, v: 1 }, { t: t0, v: 0.7 }, { t: t0 + 0.1, v: 1 })
  }
  return {
    type: 'shape',
    path: ellipse(0, 0, 40),
    fill: { type: 'solid', color: hex(c) },
    transform: { x, y: ys.filter(k => k.t >= -period && k.t <= duration + period), scaleY: squash, anchor: [0, 40] },
  }
})

const rings: SceneNode[] = [0, 1, 2].map(i => ({
  type: 'shape',
  path: ellipse(0, 0, 320 + i * 34),
  stroke: { paint: { type: 'solid', color: hex('#94a3b8', 90 - i * 25) }, width: 6, cap: 'round' },
  transform: {
    x: cx,
    y: cy,
    scaleX: [{ t: 0, v: 1, ease: 'easeInOut' }, { t: duration / 2, v: 1.08, ease: 'easeInOut' }, { t: duration, v: 1 }],
    scaleY: [{ t: 0, v: 0.35 + i * 0.1 }, { t: duration, v: 0.35 + i * 0.1 }],
    rotation: [{ t: 0, v: i * 60 }, { t: duration, v: i * 60 + (i % 2 ? -180 : 180) }],
  },
}))

const scene: Scene = {
  width: 1920,
  height: 1080,
  duration,
  loop: true,
  background: hex('#f8fafc'),
  nodes: [
    { type: 'shape', path: rect(0, floor, 1920, 80), fill: { type: 'solid', color: hex('#e2e8f0') } },
    ...rings,
    { type: 'shape', path: morph, fill: { type: 'solid', color: fills } },
    ...balls,
  ],
}

export default scene
