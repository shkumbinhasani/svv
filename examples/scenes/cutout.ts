import { ellipse, parseSvgPath, polygon, rect, type Keyframe, type Path, type Scene, type SceneNode } from '../../src/index.ts'
import { hex } from './util.ts'

const W = 1920
const H = 1080
const duration = 6
const step = 0.5
const ink = hex('#1f2937')
const outline = { paint: { type: 'solid' as const, color: ink }, width: 6, join: 'round' as const, cap: 'round' as const }

function swing(amp: number, phase = 0, offset = 0): Keyframe<number>[] {
  const n = Math.round(duration / step)
  return Array.from({ length: n + 1 }, (_, i) => ({ t: i * step, v: offset + amp * ((i + phase) % 2 ? -1 : 1), ease: 'easeInOut' as const }))
}

function limb(len: number, w: number, color: string, angle: Keyframe<number>[], x: number, y: number, child?: SceneNode): SceneNode {
  return {
    type: 'group',
    transform: { x, y, rotation: angle },
    children: [{ type: 'shape', path: rect(-w / 2, 0, w, len, w / 2), fill: { type: 'solid', color: hex(color) }, stroke: outline }, ...(child ? [child] : [])],
  }
}

const mouths: Path[] = [parseSvgPath('M-30 0 Q0 22 30 0 Q0 8 -30 0Z'), parseSvgPath('M-24 -4 Q0 36 24 -4 Q0 4 -24 -4Z'), parseSvgPath('M-20 2 Q0 10 20 2 Q0 0 -20 2Z')]
const talk: Keyframe<Path>[] = Array.from({ length: 25 }, (_, i) => ({ t: i * 0.24, v: mouths[[0, 1, 2, 1, 0, 2][i % 6]!]!, ease: 'hold' as const }))
const blink: Keyframe<number>[] = [
  { t: 0, v: 1, ease: 'hold' },
  { t: 1.9, v: 0.1, ease: 'hold' },
  { t: 2.02, v: 1, ease: 'hold' },
  { t: 4.4, v: 0.1, ease: 'hold' },
  { t: 4.52, v: 1 },
]
const look: Keyframe<number>[] = [
  { t: 0, v: 0, ease: 'easeInOut' },
  { t: 1, v: 9, ease: 'easeInOut' },
  { t: 3, v: 9, ease: 'easeInOut' },
  { t: 3.6, v: -9, ease: 'easeInOut' },
  { t: 6, v: 0 },
]

const eye = (x: number): SceneNode => ({
  type: 'group',
  transform: { x, y: -20, scaleY: blink, scaleX: 1 },
  isolate: true,
  children: [
    { type: 'shape', path: ellipse(0, 0, 22, 26), fill: { type: 'solid', color: hex('#ffffff') }, stroke: { ...outline, width: 4 } },
    {
      type: 'shape',
      path: ellipse(0, 4, 12),
      fill: { type: 'solid', color: ink },
      transform: { x: look },
      mask: { node: { type: 'shape', path: ellipse(0, 0, 21, 25), fill: { type: 'solid', color: hex('#ffffff') }, transform: { x: look.map(k => ({ ...k, v: -k.v })) } } },
    },
  ],
})

const head: SceneNode = {
  type: 'group',
  transform: { y: -190, rotation: swing(4, 1) },
  children: [
    { type: 'shape', path: ellipse(0, -60, 95, 100), fill: { type: 'solid', color: hex('#fcd34d') }, stroke: outline },
    { type: 'shape', path: parseSvgPath('M-95 -80 C-90 -170 90 -170 95 -80 C60 -120 -20 -130 -95 -80Z'), fill: { type: 'solid', color: hex('#7c2d12') }, stroke: outline },
    eye(-36),
    eye(36),
    { type: 'shape', path: talk, fill: { type: 'solid', color: hex('#9f1239') }, stroke: { ...outline, width: 4 }, transform: { y: 8 } },
  ],
}

const body: SceneNode = {
  type: 'group',
  transform: { x: 960, y: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(i => ({ t: i * step, v: 640 + (i % 2 ? 0 : -14), ease: 'easeInOut' as const })) },
  filters: [{ type: 'shadow', dx: 14, dy: 10, radius: 6, color: hex('#000000', 60) }],
  children: [
    limb(150, 46, '#1d4ed8', swing(24, 0, 0), -30, 60, limb(120, 40, '#1d4ed8', swing(14, 1, 18), 0, 140)),
    limb(150, 46, '#1e40af', swing(24, 1, 0), 30, 60, limb(120, 40, '#1e40af', swing(14, 0, 18), 0, 140)),
    { type: 'shape', path: rect(-80, -130, 160, 210, 50), fill: { type: 'solid', color: hex('#ef4444') }, stroke: outline },
    limb(130, 34, '#fcd34d', swing(30, 1, 8), -82, -110),
    limb(130, 34, '#fcd34d', swing(30, 0, -8), 82, -110),
    head,
  ],
}

const hills = (color: string, base: number, speed: number): SceneNode => ({
  type: 'shape',
  path: polygon([[0, base], [300, base - 120], [700, base - 40], [1100, base - 160], [1500, base - 60], [1900, base - 140], [2300, base - 30], [2700, base - 150], [3100, base - 50], [3840, base], [3840, H], [0, H]]),
  fill: { type: 'solid', color: hex(color) },
  transform: { x: [{ t: 0, v: 0 }, { t: duration, v: -speed * duration }] },
})

const scene: Scene = {
  width: W,
  height: H,
  duration,
  loop: true,
  background: hex('#bae6fd'),
  nodes: [
    { type: 'shape', path: ellipse(1500, 220, 90), fill: { type: 'solid', color: hex('#fde047') }, filters: [{ type: 'glow', radius: 30, color: hex('#fef08a'), strength: 1.5 }] },
    hills('#86efac', 820, 60),
    hills('#4ade80', 900, 160),
    { type: 'shape', path: rect(0, 900, W, 180), fill: { type: 'solid', color: hex('#65a30d') } },
    { type: 'shape', path: ellipse(960, 975, 150, 22), fill: { type: 'solid', color: hex('#3f6212') } },
    body,
  ],
}

export default scene
