import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ellipse, fontFromBytes, rect, type Keyframe, type Scene, type SceneNode } from '../../src/index.ts'
import { hex, rng } from './util.ts'

const W = 1920
const H = 1080
const duration = 6
const title = 'SCALABLE VECTOR VIDEO'
const subtitle = 'any size · any frame rate · a few kilobytes'
const font = fontFromBytes(readFileSync(join(import.meta.dir, '..', 'fonts', 'lilita', 'LilitaOne-Regular.ttf')), title + subtitle)
const rand = rng(99)

const bokeh: SceneNode[] = Array.from({ length: 14 }, (_, i) => {
  const x = rand() * W
  const y = rand() * H
  const r = 40 + rand() * 120
  const drift = (rand() - 0.5) * 300
  return {
    type: 'shape',
    path: ellipse(0, 0, r),
    fill: { type: 'solid', color: hex(i % 3 ? '#38bdf8' : '#a78bfa', 70) },
    filters: [{ type: 'blur', radius: 18 + rand() * 20 }],
    blend: 'screen',
    transform: { x: [{ t: 0, v: x }, { t: duration, v: x + drift }], y: [{ t: 0, v: y, ease: 'smooth' }, { t: duration / 2, v: y - 60, ease: 'smooth' }, { t: duration, v: y }] },
  }
})

const reveal: Keyframe<number>[] = [
  { t: 0.4, v: -1400, ease: 'easeOut' },
  { t: 1.6, v: 0 },
  { t: 5.2, v: 0, ease: 'easeIn' },
  { t: 5.9, v: 1400 },
]

const scene: Scene = {
  width: W,
  height: H,
  duration,
  loop: true,
  assets: [font],
  nodes: [
    { type: 'shape', path: rect(0, 0, W, H), fill: { type: 'linear', from: [0, 0], to: [W, H], stops: [{ offset: 0, color: hex('#020617') }, { offset: 1, color: hex('#1e1b4b') }] } },
    { type: 'group', children: bokeh },
    {
      type: 'text',
      text: title,
      font: 0,
      size: 128,
      align: 'center',
      letterSpacing: 6,
      fill: { type: 'linear', from: [-700, -100], to: [700, 0], stops: [{ offset: 0, color: hex('#e0f2fe') }, { offset: 1, color: hex('#c4b5fd') }] },
      transform: { x: W / 2, y: 560 },
      filters: [{ type: 'shadow', dx: 0, dy: 10, radius: 14, color: hex('#000000', 160) }],
      mask: { node: { type: 'shape', path: rect(-750, -140, 1500, 200), fill: { type: 'solid', color: hex('#ffffff') }, transform: { x: reveal } } },
    },
    {
      type: 'shape',
      path: rect(-420, -4, 840, 8, 4),
      fill: { type: 'solid', color: hex('#22d3ee') },
      filters: [{ type: 'glow', radius: 12, color: hex('#22d3ee'), strength: [{ t: 1.4, v: 0.5, ease: 'smooth' }, { t: 3, v: 2, ease: 'smooth' }, { t: 4.6, v: 0.5 }] }],
      transform: { x: W / 2, y: 610, scaleX: [{ t: 1, v: 0, ease: 'easeOut' }, { t: 1.8, v: 1 }, { t: 5.2, v: 1, ease: 'easeIn' }, { t: 5.7, v: 0 }], scaleY: 1 },
    },
    {
      type: 'text',
      text: subtitle,
      font: 0,
      size: 44,
      align: 'center',
      fill: { type: 'solid', color: hex('#94a3b8') },
      transform: { x: W / 2, y: 690 },
      opacity: [{ t: 1.8, v: 0, ease: 'easeOut' }, { t: 2.6, v: 1 }, { t: 5, v: 1 }, { t: 5.5, v: 0 }],
    },
    {
      type: 'shape',
      path: rect(-60, -700, 120, 1400),
      fill: { type: 'linear', from: [-60, 0], to: [60, 0], stops: [{ offset: 0, color: hex('#ffffff', 0) }, { offset: 0.5, color: hex('#ffffff', 90) }, { offset: 1, color: hex('#ffffff', 0) }] },
      blend: 'add',
      transform: { x: [{ t: 2.2, v: 200, ease: 'easeInOut' }, { t: 3.4, v: 1720 }], y: H / 2, rotation: 18 },
      start: 2.2,
      end: 3.4,
    },
  ],
}

export default scene
