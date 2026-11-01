import { compile, multiply, type CompiledScene, type LayerItem, type Matrix, type RenderItem, type ResolvedPaint } from './evaluate.ts'
import { unflattenPath, pathToSvg } from './path.ts'
import type { Color, Scene } from './model.ts'

const rgb = (c: Color) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`
const alpha = (c: Color) => +(c[3] / 255).toFixed(4)
const num = (v: number) => +v.toFixed(4)
const mat = (m: Matrix) => `matrix(${m.map(v => +v.toFixed(5)).join(' ')})`

function base64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function frameToSvg(scene: Scene | CompiledScene, time: number): string {
  const compiled = 'sample' in scene ? scene : compile(scene)
  const { width, height, background } = compiled.scene
  const assets = compiled.scene.assets ?? []
  const defs: string[] = []
  let ids = 0
  const id = (p: string) => `${p}${ids++}`
  const paint = (p: ResolvedPaint, attr: 'fill' | 'stroke'): string => {
    if (p.type === 'solid') return `${attr}="${rgb(p.color)}"${p.color[3] < 255 ? ` ${attr}-opacity="${alpha(p.color)}"` : ''}`
    const g = id('g')
    const stops = p.stops.map(s => `<stop offset="${s.offset}" stop-color="${rgb(s.color)}" stop-opacity="${alpha(s.color)}"/>`).join('')
    defs.push(
      p.type === 'linear'
        ? `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="${p.from[0]}" y1="${p.from[1]}" x2="${p.to[0]}" y2="${p.to[1]}">${stops}</linearGradient>`
        : `<radialGradient id="${g}" gradientUnits="userSpaceOnUse" cx="${p.center[0]}" cy="${p.center[1]}" r="${p.radius}">${stops}</radialGradient>`,
    )
    return `${attr}="url(#${g})"`
  }
  const blendAttr = (b: string) => (b === 'source-over' ? '' : ` style="mix-blend-mode:${b === 'lighter' ? 'plus-lighter' : b}"`)
  const render = (items: RenderItem[]): string =>
    items
      .map(item => {
        if (item.kind === 'path') {
          const attrs = [`d="${pathToSvg(unflattenPath(item.topology, item.coords))}"`, `transform="${mat(item.matrix)}"`]
          if (item.opacity < 1) attrs.push(`opacity="${num(item.opacity)}"`)
          attrs.push(item.fill ? paint(item.fill, 'fill') : 'fill="none"')
          if (item.fillRule === 'evenodd') attrs.push('fill-rule="evenodd"')
          if (item.stroke) attrs.push(paint(item.stroke.paint, 'stroke'), `stroke-width="${num(item.stroke.width)}"`, `stroke-linejoin="${item.stroke.join}"`, `stroke-linecap="${item.stroke.cap}"`)
          return `<path ${attrs.join(' ')}${blendAttr(item.blend)}/>`
        }
        if (item.kind === 'image' || item.kind === 'video') {
          const a = assets[item.asset]
          if (a?.type !== 'image') return ''
          const [x, y, w, h] = item.rect
          return `<image transform="${mat(item.matrix)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"${item.opacity < 1 ? ` opacity="${num(item.opacity)}"` : ''} href="data:${a.mime};base64,${base64(a.data)}"${blendAttr(item.blend)}/>`
        }
        const layer = item as LayerItem
        const attrs: string[] = []
        if (layer.opacity < 1) attrs.push(`opacity="${num(layer.opacity)}"`)
        if (layer.filters.length) {
          const f = id('f')
          const k = Math.sqrt(Math.abs(layer.matrix[0] * layer.matrix[3] - layer.matrix[1] * layer.matrix[2]))
          let prev = 'SourceGraphic'
          const prims: string[] = []
          layer.filters.forEach((flt, i) => {
            const r = flt.radius * k
            if (flt.type === 'blur') {
              prims.push(`<feGaussianBlur in="${prev}" stdDeviation="${num(r)}" result="r${i}"/>`)
            } else {
              const m = multiply([1, 0, 0, 1, 0, 0], layer.matrix)
              const dx = flt.type === 'shadow' ? m[0] * flt.dx + m[2] * flt.dy : 0
              const dy = flt.type === 'shadow' ? m[1] * flt.dx + m[3] * flt.dy : 0
              const strength = flt.type === 'glow' ? flt.strength : 1
              prims.push(
                `<feGaussianBlur in="${prev}" stdDeviation="${num(r)}" result="b${i}"/>`,
                `<feOffset in="b${i}" dx="${num(dx)}" dy="${num(dy)}" result="o${i}"/>`,
                `<feFlood flood-color="${rgb(flt.color)}" flood-opacity="${num(Math.min(1, (flt.color[3] / 255) * strength))}"/>`,
                `<feComposite operator="in" in2="o${i}" result="c${i}"/>`,
                `<feMerge result="r${i}"><feMergeNode in="c${i}"/><feMergeNode in="${prev}"/></feMerge>`,
              )
            }
            prev = `r${i}`
          })
          defs.push(`<filter id="${f}" filterUnits="userSpaceOnUse" x="${-width}" y="${-height}" width="${width * 3}" height="${height * 3}">${prims.join('')}</filter>`)
          attrs.push(`filter="url(#${f})"`)
        }
        let content = render(layer.items)
        if (layer.mask) {
          const m = id('m')
          const inner = render(layer.mask.items)
          defs.push(
            layer.mask.invert
              ? `<mask id="${m}" maskUnits="userSpaceOnUse" x="${-width}" y="${-height}" width="${width * 3}" height="${height * 3}" style="mask-type:luminance"><rect x="${-width}" y="${-height}" width="${width * 3}" height="${height * 3}" fill="#fff"/><g style="mix-blend-mode:normal" filter="none">${inner.replace(/fill="[^"]*"/g, 'fill="#000"')}</g></mask>`
              : `<mask id="${m}" maskUnits="userSpaceOnUse" x="${-width}" y="${-height}" width="${width * 3}" height="${height * 3}" style="mask-type:alpha">${inner}</mask>`,
          )
          content = `<g mask="url(#${m})">${content}</g>`
        }
        return `<g ${attrs.join(' ')}${blendAttr(layer.blend)}>${content}</g>`
      })
      .join('')
  const body = render(compiled.sample(time))
  const bg = background ? `<rect width="${width}" height="${height}" fill="${rgb(background)}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><defs>${defs.join('')}</defs>${bg}${body}</svg>`
}
