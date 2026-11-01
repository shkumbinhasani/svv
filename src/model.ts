export type Vec = [number, number]

export type Color = [number, number, number, number]

export interface Segment {
  c1?: Vec
  c2?: Vec
  to: Vec
}

export interface Subpath {
  start: Vec
  segments: Segment[]
  closed: boolean
  spline?: boolean
  corners?: boolean[]
}

export type Path = Subpath[]

export type EasingPreset = 'linear' | 'hold' | 'ease' | 'easeIn' | 'easeOut' | 'easeInOut' | 'smooth'

export type Easing = EasingPreset | [number, number, number, number]

export interface Keyframe<T> {
  t: number
  v: T
  ease?: Easing
}

export type Track<T> = T | Keyframe<T>[]

export interface GradientStop {
  offset: number
  color: Color
}

export type Paint =
  | { type: 'solid'; color: Track<Color> }
  | { type: 'linear'; from: Vec; to: Vec; stops: GradientStop[] }
  | { type: 'radial'; center: Vec; radius: number; stops: GradientStop[] }

export type LineJoin = 'miter' | 'round' | 'bevel'
export type LineCap = 'butt' | 'round' | 'square'

export interface Stroke {
  paint: Paint
  width: Track<number>
  join?: LineJoin
  cap?: LineCap
}

export interface Transform {
  x?: Track<number>
  y?: Track<number>
  rotation?: Track<number>
  scaleX?: Track<number>
  scaleY?: Track<number>
  anchor?: Vec
}

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export type Filter =
  | { type: 'blur'; radius: Track<number> }
  | { type: 'glow'; radius: Track<number>; color: Track<Color>; strength?: Track<number> }
  | { type: 'shadow'; dx: Track<number>; dy: Track<number>; radius: Track<number>; color: Track<Color> }

export interface Mask {
  node: SceneNode
  invert?: boolean
}

export interface NodeBase {
  transform?: Transform
  opacity?: Track<number>
  start?: number
  end?: number
  blend?: BlendMode
  filters?: Filter[]
  mask?: Mask
  isolate?: boolean
}

export interface ShapeNode extends NodeBase {
  type: 'shape'
  path: Track<Path>
  fill?: Paint
  stroke?: Stroke
  fillRule?: 'nonzero' | 'evenodd'
}

export interface GroupNode extends NodeBase {
  type: 'group'
  children: SceneNode[]
}

export interface UseNode extends NodeBase {
  type: 'use'
  ref: number
}

export interface TextNode extends NodeBase {
  type: 'text'
  text: string
  font: number
  size: Track<number>
  align?: 'left' | 'center' | 'right'
  letterSpacing?: number
  lineHeight?: number
  fill?: Paint
  stroke?: Stroke
}

export interface MediaRect {
  x?: number
  y?: number
  width: number
  height: number
}

export interface ImageNode extends NodeBase, MediaRect {
  type: 'image'
  asset: number
}

export interface VideoNode extends NodeBase, MediaRect {
  type: 'video'
  asset: number
}

export type SceneNode = ShapeNode | GroupNode | UseNode | TextNode | ImageNode | VideoNode

export interface Glyph {
  char: string
  advance: number
  path: Path
}

export interface FontAsset {
  type: 'font'
  unitsPerEm: number
  ascent: number
  descent: number
  glyphs: Glyph[]
  kerning?: [string, string, number][]
}

export type ImageMime = 'image/avif' | 'image/webp' | 'image/png' | 'image/jpeg'

export interface ImageAsset {
  type: 'image'
  mime: ImageMime
  width: number
  height: number
  data: Uint8Array
}

export interface VideoFrame {
  t: number
  key: boolean
  data: Uint8Array
}

export interface VideoAsset {
  type: 'video'
  codec: string
  width: number
  height: number
  frames: VideoFrame[]
}

export interface AudioSegment {
  t: number
  data: Uint8Array
}

export interface AudioAsset {
  type: 'audio'
  codec: string
  sampleRate: number
  channels: number
  segments: AudioSegment[]
}

export type Asset = FontAsset | ImageAsset | VideoAsset | AudioAsset

export interface Scene {
  width: number
  height: number
  duration: number
  loop?: boolean
  background?: Color
  assets?: Asset[]
  audio?: number
  defs?: SceneNode[]
  nodes: SceneNode[]
}

export function isKeyframes<T>(track: Track<T>): track is Keyframe<T>[] {
  return Array.isArray(track) && track.length > 0 && typeof track[0] === 'object' && track[0] !== null && 't' in (track[0] as object)
}
