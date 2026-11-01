import { isKeyframes, type Filter, type Paint, type Scene, type SceneNode, type Stroke, type Track, type Transform } from './model.ts'

export interface ChunkScene {
  start: number
  end: number
  defs: SceneNode[]
  nodes: SceneNode[]
}

export function trimTrack<T>(track: Track<T>, a: number, b: number): Track<T> {
  if (!isKeyframes(track)) return track
  const n = track.length
  if (track[n - 1]!.t <= a) return track[n - 1]!.v
  if (track[0]!.t >= b) return track[0]!.v
  let lo = 0
  for (let i = 0; i < n; i++) if (track[i]!.t <= a) lo = i
  let hi = n - 1
  for (let i = n - 1; i >= 0; i--) if (track[i]!.t >= b) hi = i
  const from = Math.max(0, lo - 1)
  const to = Math.min(n - 1, hi + 1)
  const kept = track.slice(from, to + 1)
  if (kept.every(k => sameValue(k.v, kept[0]!.v))) return kept[0]!.v
  return kept
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

function trimPaint(p: Paint, a: number, b: number): Paint {
  return p.type === 'solid' ? { type: 'solid', color: trimTrack(p.color, a, b) } : p
}

function trimStroke(s: Stroke, a: number, b: number): Stroke {
  return { ...s, paint: trimPaint(s.paint, a, b), width: trimTrack(s.width, a, b) }
}

function trimTransform(t: Transform, a: number, b: number): Transform {
  const out: Transform = {}
  for (const k of ['x', 'y', 'rotation', 'scaleX', 'scaleY'] as const) if (t[k] !== undefined) out[k] = trimTrack(t[k]!, a, b)
  if (t.anchor) out.anchor = t.anchor
  return out
}

function trimFilter(f: Filter, a: number, b: number): Filter {
  if (f.type === 'blur') return { type: 'blur', radius: trimTrack(f.radius, a, b) }
  if (f.type === 'glow') {
    const g: Filter = { type: 'glow', radius: trimTrack(f.radius, a, b), color: trimTrack(f.color, a, b) }
    if (f.strength !== undefined) g.strength = trimTrack(f.strength, a, b)
    return g
  }
  return { type: 'shadow', dx: trimTrack(f.dx, a, b), dy: trimTrack(f.dy, a, b), radius: trimTrack(f.radius, a, b), color: trimTrack(f.color, a, b) }
}

function visible(n: SceneNode, a: number, b: number): boolean {
  return !(n.end !== undefined && n.end <= a) && !(n.start !== undefined && n.start >= b)
}

function trimNode(n: SceneNode, a: number, b: number, refs: Map<number, number>, keepHidden = false): SceneNode | null {
  if (!keepHidden && !visible(n, a, b)) return null
  const base: Partial<SceneNode> = {}
  if (n.start !== undefined) base.start = n.start
  if (n.end !== undefined) base.end = n.end
  if (n.opacity !== undefined) base.opacity = trimTrack(n.opacity, a, b)
  if (n.transform) base.transform = trimTransform(n.transform, a, b)
  if (n.blend) base.blend = n.blend
  if (n.isolate) base.isolate = true
  if (n.filters?.length) base.filters = n.filters.map(f => trimFilter(f, a, b))
  if (n.mask) {
    const node = trimNode(n.mask.node, a, b, refs, true)!
    base.mask = n.mask.invert ? { node, invert: true } : { node }
  }
  switch (n.type) {
    case 'group': {
      const children = n.children.map(c => trimNode(c, a, b, refs)).filter((c): c is SceneNode => c !== null)
      if (!children.length && !keepHidden) return null
      return { ...base, type: 'group', children } as SceneNode
    }
    case 'use': {
      if (!refs.has(n.ref)) refs.set(n.ref, -1)
      return { ...base, type: 'use', ref: n.ref } as SceneNode
    }
    case 'shape': {
      const s: SceneNode = { ...base, type: 'shape', path: trimTrack(n.path, a, b) } as SceneNode
      if (s.type !== 'shape') throw new Error('unreachable')
      if (n.fill) s.fill = trimPaint(n.fill, a, b)
      if (n.stroke) s.stroke = trimStroke(n.stroke, a, b)
      if (n.fillRule) s.fillRule = n.fillRule
      return s
    }
    case 'text': {
      const t = { ...n, ...base, size: trimTrack(n.size, a, b) } as SceneNode
      if (t.type !== 'text') throw new Error('unreachable')
      if (n.fill) t.fill = trimPaint(n.fill, a, b)
      if (n.stroke) t.stroke = trimStroke(n.stroke, a, b)
      return t
    }
    case 'image':
    case 'video':
      return { ...n, ...base } as SceneNode
  }
}

function remapRefs(n: SceneNode, map: Map<number, number>) {
  if (n.type === 'use') n.ref = map.get(n.ref)!
  if (n.type === 'group') n.children.forEach(c => remapRefs(c, map))
  if (n.mask) remapRefs(n.mask.node, map)
}

export function sliceScene(scene: Scene, a: number, b: number): ChunkScene {
  const refs = new Map<number, number>()
  const nodes = scene.nodes.map(n => trimNode(n, a, b, refs)).filter((n): n is SceneNode => n !== null)
  const defs = scene.defs ?? []
  const trimmedDefs = new Map<number, SceneNode>()
  const pending = [...refs.keys()]
  while (pending.length) {
    const i = pending.pop()!
    if (trimmedDefs.has(i)) continue
    const d = defs[i]
    if (!d) throw new Error(`use ref ${i} is not defined`)
    const inner = new Map<number, number>()
    trimmedDefs.set(i, trimNode(d, a, b, inner, true)!)
    for (const k of inner.keys()) {
      if (k >= i) throw new Error(`def ${i} refers to def ${k}; defs may only use earlier defs`)
      refs.set(k, -1)
      pending.push(k)
    }
  }
  const order = [...trimmedDefs.keys()].sort((x, y) => x - y)
  const map = new Map(order.map((old, i) => [old, i]))
  const outDefs = order.map(i => trimmedDefs.get(i)!)
  for (const d of outDefs) remapRefs(d, map)
  for (const n of nodes) remapRefs(n, map)
  return { start: a, end: b, defs: outDefs, nodes }
}

export function chunkBounds(duration: number, chunkDuration: number): [number, number][] {
  if (duration <= 0 || chunkDuration <= 0 || chunkDuration >= duration) return [[0, Math.max(duration, 0)]]
  const out: [number, number][] = []
  for (let a = 0; a < duration - 1e-9; a += chunkDuration) out.push([a, Math.min(duration, a + chunkDuration)])
  return out
}

export function usedAssets(nodes: SceneNode[], defs: SceneNode[]): Set<number> {
  const out = new Set<number>()
  const walk = (n: SceneNode) => {
    if (n.type === 'text' || n.type === 'image' || n.type === 'video') out.add(n.type === 'text' ? n.font : n.asset)
    if (n.type === 'group') n.children.forEach(walk)
    if (n.mask) walk(n.mask.node)
  }
  nodes.forEach(walk)
  defs.forEach(walk)
  return out
}
