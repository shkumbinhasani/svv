import { ellipse, polygon, rect, smoothPolyline, type Path, type Scene, type SceneNode, type Vec } from '../../src/index.ts'
import { hex, rng } from './util.ts'

const W = 1920
const H = 1080
const duration = 10
const rand = rng(7)

function ridge(base: number, amp: number, count: number, seed: number, smooth: boolean): Path {
  const r = rng(seed)
  const pts: Vec[] = []
  for (let i = 0; i <= count; i++) {
    const x = (i / count) * W * 2
    const y = base - (i === 0 || i === count ? amp * 0.5 : amp * (0.2 + r() * 0.8))
    pts.push([x, y])
  }
  pts[count] = [W * 2, pts[0]![1]]
  const top = smooth ? smoothPolyline(pts)[0]! : polygon(pts, false)[0]!
  return [{ ...top, segments: [...top.segments, { to: [W * 2, H] }, { to: [0, H] }], closed: true }]
}

function layer(path: Path, color: string, speed: number): SceneNode {
  return {
    type: 'shape',
    path,
    fill: { type: 'solid', color: hex(color) },
    transform: { x: [{ t: 0, v: 0 }, { t: duration, v: -W * speed }] },
  }
}

function tile(node: SceneNode, speed: number): SceneNode {
  return { type: 'group', children: [node, { ...node, transform: { x: [{ t: 0, v: W * 2 }, { t: duration, v: W * 2 - W * speed }] } }] }
}

const cloud = (cx: number, cy: number, s: number): SceneNode => ({
  type: 'group',
  transform: { x: [{ t: 0, v: cx }, { t: duration, v: cx - 500 * s }], y: cy, scaleX: s, scaleY: s },
  children: [
    [0, 0, 70],
    [70, -30, 85],
    [150, 0, 65],
    [75, 20, 70],
  ].map(([x, y, r]) => ({ type: 'shape', path: ellipse(x!, y!, r!), fill: { type: 'solid', color: hex('#fff7ed') } })),
})

const wingUp = polygon([[-40, -18], [-14, 0], [0, -4], [14, 0], [40, -18], [16, 6], [0, 2], [-16, 6]])
const wingDown = polygon([[-36, 22], [-14, 0], [0, -4], [14, 0], [36, 22], [16, 8], [0, 2], [-16, 8]])
const flap = Array.from({ length: Math.round(duration / 0.25) + 1 }, (_, i) => ({ t: i * 0.25, v: i % 2 ? wingDown : wingUp, ease: 'easeInOut' as const }))

const birds: SceneNode[] = Array.from({ length: 5 }, (_, i) => {
  const y0 = 300 + rand() * 180
  return {
    type: 'group',
    transform: {
      x: [{ t: 0, v: -200 - i * 140 }, { t: duration, v: W + 400 - i * 140 }],
      y: [{ t: 0, v: y0, ease: 'smooth' }, { t: 3, v: y0 - 60, ease: 'smooth' }, { t: 6, v: y0 + 30, ease: 'smooth' }, { t: duration, v: y0 }],
      scaleX: 0.8 + rand() * 0.5,
      scaleY: 0.8 + rand() * 0.5,
    },
    children: [{ type: 'shape', path: flap.map(k => ({ ...k, t: Math.min(duration, k.t + i * 0.07) })), fill: { type: 'solid', color: hex('#1e293b') } }],
  }
})

const scene: Scene = {
  width: W,
  height: H,
  duration,
  loop: true,
  nodes: [
    {
      type: 'shape',
      path: rect(0, 0, W, H),
      fill: { type: 'linear', from: [0, 0], to: [0, H], stops: [{ offset: 0, color: hex('#fb923c') }, { offset: 0.55, color: hex('#fde68a') }, { offset: 1, color: hex('#fef3c7') }] },
    },
    {
      type: 'shape',
      path: ellipse(0, 0, 260),
      fill: { type: 'radial', center: [0, 0], radius: 260, stops: [{ offset: 0, color: hex('#fff7ed') }, { offset: 0.35, color: hex('#fdba74') }, { offset: 1, color: hex('#fdba74', 0) }] },
      transform: { x: [{ t: 0, v: 700, ease: 'smooth' }, { t: 5, v: 1000, ease: 'smooth' }, { t: duration, v: 700 }], y: [{ t: 0, v: 520, ease: 'smooth' }, { t: 5, v: 440, ease: 'smooth' }, { t: duration, v: 520 }] },
    },
    cloud(300, 220, 1),
    cloud(1300, 160, 0.7),
    cloud(1700, 300, 0.85),
    tile(layer(ridge(640, 260, 14, 1, false), '#c2410c', 0.25), 0.25),
    tile(layer(ridge(760, 200, 10, 2, true), '#9a3412', 0.5), 0.5),
    ...birds,
    tile(layer(ridge(900, 160, 8, 3, true), '#7c2d12', 1), 1),
    tile(layer(ridge(1010, 90, 6, 4, true), '#431407', 2), 2),
  ],
}

export default scene
