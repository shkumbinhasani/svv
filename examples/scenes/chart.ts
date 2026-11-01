import { line, rect, smoothPolyline, type Scene, type SceneNode, type Vec } from '../../src/index.ts'
import { hex, rng } from './util.ts'

const rand = rng(42)
const left = 200
const right = 1720
const bottom = 900
const top = 220
const bars = 12
const values = Array.from({ length: bars }, (_, i) => 0.25 + 0.6 * Math.abs(Math.sin(i * 0.7)) + rand() * 0.15)
const trend = Array.from({ length: bars }, (_, i) => 0.3 + i * 0.045 + rand() * 0.08)
const slot = (right - left) / bars
const palette = ['#38bdf8', '#818cf8']

const grid: SceneNode[] = Array.from({ length: 6 }, (_, i) => {
  const y = bottom - (i / 5) * (bottom - top)
  return {
    type: 'shape',
    path: line([[left, y], [right, y]]),
    stroke: { paint: { type: 'solid', color: hex('#334155') }, width: i === 0 ? 4 : 2 },
    opacity: [{ t: 0, v: 0 }, { t: 0.3 + i * 0.05, v: 1 }],
  }
})

const barNodes: SceneNode[] = values.map((v, i) => {
  const h = v * (bottom - top)
  const x = left + i * slot + slot * 0.18
  const t0 = 0.4 + i * 0.08
  return {
    type: 'shape',
    path: rect(x, bottom - h, slot * 0.64, h, 10),
    fill: { type: 'linear', from: [0, bottom - h], to: [0, bottom], stops: [{ offset: 0, color: hex(palette[i % 2]!) }, { offset: 1, color: hex(palette[i % 2]!, 60) }] },
    transform: {
      anchor: [0, bottom],
      y: bottom,
      scaleY: [
        { t: t0, v: 0, ease: [0.2, 0.9, 0.3, 1.15] },
        { t: t0 + 0.9, v: 1 },
        { t: 5.2, v: 1, ease: 'easeIn' },
        { t: 5.8, v: 0 },
      ],
    },
  }
})

const pts = (vals: number[]): Vec[] => vals.map((v, i) => [left + (i + 0.5) * slot, bottom - v * (bottom - top)])
const flat = pts(trend.map(() => 0))
const curve: SceneNode = {
  type: 'shape',
  path: [
    { t: 1.4, v: smoothPolyline(flat), ease: 'easeOut' },
    { t: 2.6, v: smoothPolyline(pts(trend)), ease: 'smooth' },
    { t: 3.6, v: smoothPolyline(pts(trend.map((v, i) => v * (0.9 + 0.2 * Math.sin(i))))), ease: 'smooth' },
    { t: 4.6, v: smoothPolyline(pts(trend)), ease: 'easeIn' },
    { t: 5.6, v: smoothPolyline(flat) },
  ],
  stroke: { paint: { type: 'solid', color: hex('#fbbf24') }, width: 10, cap: 'round', join: 'round' },
  opacity: [{ t: 1.3, v: 0 }, { t: 1.6, v: 1 }, { t: 5.4, v: 1 }, { t: 5.8, v: 0 }],
}

const scene: Scene = {
  width: 1920,
  height: 1080,
  duration: 6,
  loop: true,
  background: hex('#0b1120'),
  nodes: [
    { type: 'shape', path: rect(120, 120, 1680, 860, 36), fill: { type: 'solid', color: hex('#111a2e') } },
    ...grid,
    ...barNodes,
    curve,
  ],
}

export default scene
