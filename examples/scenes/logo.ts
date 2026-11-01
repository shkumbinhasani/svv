import { ellipse, rect, smoothPolyline, type Path, type Scene, type SceneNode, type Vec } from '../../src/index.ts'
import { hex } from './util.ts'

const cx = 960
const cy = 540
const sPoints: Vec[] = [
  [1035, 445],
  [990, 405],
  [915, 412],
  [885, 470],
  [930, 525],
  [1010, 560],
  [1045, 625],
  [1005, 680],
  [925, 682],
  [880, 640],
]
const collapsed: Path = smoothPolyline(sPoints.map((): Vec => sPoints[0]!))

const orbiters: SceneNode[] = Array.from({ length: 12 }, (_, i) => ({
  type: 'group',
  transform: {
    x: cx,
    y: cy,
    rotation: [
      { t: 0, v: i * 30 },
      { t: 4, v: i * 30 + 360 },
    ],
  },
  children: [{ type: 'use', ref: 0, transform: { x: 330 + (i % 3) * 40 } }],
}))

const scene: Scene = {
  width: 1920,
  height: 1080,
  duration: 4,
  loop: true,
  background: hex('#0f172a'),
  defs: [{ type: 'shape', path: ellipse(0, 0, 9), fill: { type: 'solid', color: hex('#67e8f9') } }],
  nodes: [
    {
      type: 'shape',
      path: ellipse(cx, cy, 520),
      fill: { type: 'radial', center: [cx, cy], radius: 520, stops: [{ offset: 0, color: hex('#0891b2', 140) }, { offset: 1, color: hex('#0891b2', 0) }] },
      opacity: [
        { t: 0, v: 0.2, ease: 'easeInOut' },
        { t: 2, v: 1, ease: 'easeInOut' },
        { t: 4, v: 0.2 },
      ],
    },
    { type: 'group', children: orbiters, opacity: [{ t: 0, v: 0 }, { t: 0.8, v: 1 }, { t: 3.5, v: 1 }, { t: 4, v: 0 }] },
    {
      type: 'shape',
      path: rect(cx - 180, cy - 180, 360, 360, 80),
      fill: { type: 'linear', from: [cx - 180, cy - 180], to: [cx + 180, cy + 180], stops: [{ offset: 0, color: hex('#22d3ee') }, { offset: 1, color: hex('#0e7490') }] },
      transform: {
        anchor: [cx, cy],
        x: cx,
        y: cy,
        scaleX: [
          { t: 0, v: 0, ease: [0.34, 1.56, 0.64, 1] },
          { t: 0.9, v: 1 },
          { t: 3.4, v: 1, ease: 'easeIn' },
          { t: 4, v: 0 },
        ],
        rotation: [
          { t: 0, v: -120, ease: 'easeOut' },
          { t: 0.9, v: 0 },
          { t: 3.4, v: 0, ease: 'easeIn' },
          { t: 4, v: 90 },
        ],
      },
    },
    {
      type: 'shape',
      path: [
        { t: 0.5, v: collapsed, ease: 'easeInOut' },
        { t: 1.5, v: smoothPolyline(sPoints) },
        { t: 3.2, v: smoothPolyline(sPoints), ease: 'easeIn' },
        { t: 3.7, v: collapsed },
      ],
      stroke: { paint: { type: 'solid', color: hex('#ffffff') }, width: 44, cap: 'round', join: 'round' },
    },
  ],
}

scene.nodes[2]!.transform!.scaleY = scene.nodes[2]!.transform!.scaleX
export default scene
