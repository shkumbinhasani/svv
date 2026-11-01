import { expect, test } from 'bun:test'
import { compile, cubicBezierEase, decode, encode, flattenItems, rect, sampler, toScene, type Scene } from '../src/index.ts'

test('linear interpolation is continuous in time', () => {
  const s = sampler([0, 1], [[0], [100]], ['linear'])
  expect(s(0.25)[0]).toBeCloseTo(25)
  expect(s(0.123456)[0]).toBeCloseTo(12.3456)
  expect(s(-1)[0]).toBe(0)
  expect(s(5)[0]).toBe(100)
})

test('hold and zero-length spans jump', () => {
  const s = sampler([0, 1, 1, 2], [[0], [10], [20], [30]], ['hold', 'linear', 'linear'])
  expect(s(0.99)[0]).toBe(0)
  expect(s(1)[0]).toBe(20)
  expect(s(1.5)[0]).toBeCloseTo(25)
})

test('smooth passes through keyframes with continuous velocity', () => {
  const s = sampler([0, 1, 2], [[0], [10], [0]], ['smooth', 'smooth'])
  expect(s(1)[0]).toBeCloseTo(10)
  const eps = 1e-4
  const left = (s(1)[0]! - s(1 - eps)[0]!) / eps
  const right = (s(1 + eps)[0]! - s(1)[0]!) / eps
  expect(Math.abs(left - right)).toBeLessThan(1e-2)
})

test('cubic bezier easing matches CSS ease endpoints and midpoint', () => {
  const ease = cubicBezierEase(0.42, 0, 0.58, 1)
  expect(ease(0)).toBe(0)
  expect(ease(1)).toBe(1)
  expect(ease(0.5)).toBeCloseTo(0.5, 5)
  expect(cubicBezierEase(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 5)
})

test('scene sampling honors loop, visibility windows and transforms', () => {
  const scene: Scene = {
    width: 100,
    height: 100,
    duration: 2,
    nodes: [
      { type: 'shape', path: rect(0, 0, 10, 10), start: 0.5, end: 1.5, fill: { type: 'solid', color: [0, 0, 0, 255] } },
      { type: 'shape', path: rect(0, 0, 10, 10), transform: { x: [{ t: 0, v: 0 }, { t: 2, v: 80 }], rotation: 90 } },
    ],
  }
  const c = compile(toScene(decode(encode(scene))))
  const items = (t: number) => flattenItems(c.sample(t))
  expect(items(0.25)).toHaveLength(1)
  expect(items(1)).toHaveLength(2)
  expect(items(2.25)).toHaveLength(1)
  const m = items(1)[1]!.matrix
  expect(m[4]).toBeCloseTo(40, 1)
  expect(m[0]).toBeCloseTo(0, 6)
  expect(m[1]).toBeCloseTo(1, 6)
})

test('morphing between different shapes yields matching topology at every time', () => {
  const scene: Scene = {
    width: 100,
    height: 100,
    duration: 1,
    nodes: [{ type: 'shape', path: [{ t: 0, v: rect(10, 10, 20, 20) }, { t: 1, v: [{ start: [50, 50], segments: [{ c1: [60, 40], c2: [70, 60], to: [80, 50] }, { to: [65, 80] }], closed: true }] }] }],
  }
  const c = compile(toScene(decode(encode(scene))))
  const a = flattenItems(c.sample(0))[0]!
  const b = flattenItems(c.sample(0.999))[0]!
  expect(a.coords.length).toBe(b.coords.length)
  expect(a.topology).toEqual(b.topology)
})
