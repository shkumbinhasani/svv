# SVV format, version 2

SVV (Scalable Vector Video) stores moving pictures as shapes and keyframes instead of pixels and frames. A decoder rebuilds the scene and a renderer draws it at whatever pixel size and whatever instant the viewer asks for. Shapes carry no resolution and keyframes carry no frame rate. Content that does not reduce to shapes (painted backgrounds, textures, camera footage) rides along as embedded raster images or AV1 video layers, so one file can mix both.

- File extension: `.svv`
- Suggested media type: `video/x-svv`

## 1. Scene model

### 1.1 Scene

| Field | Meaning |
|---|---|
| `width`, `height` | Size of the canvas in scene units. Units have no physical size. |
| `duration` | Length in seconds. |
| `loop` | If true, time wraps: `t mod duration`. If false, time clamps to `[0, duration]`. |
| `background` | Optional RGBA color painted over the whole output before any node. |
| `assets` | Fonts, images, video layers and audio, referenced by index. |
| `audio` | Optional index of the audio asset that plays with the scene. |
| `defs` | Nodes that are not drawn on their own. A `use` node draws one. |
| `nodes` | The nodes drawn, in painter's order (first is bottom). |

### 1.2 Nodes

Every node has these optional fields:

| Field | Default | Meaning |
|---|---|---|
| `start` | −∞ | The node draws only when `start ≤ t`. |
| `end` | +∞ | The node draws only when `t < end`. |
| `opacity` | 1 | Number track. |
| `transform` | identity | See 1.6. |
| `blend` | `normal` | One of `normal multiply screen overlay darken lighten color-dodge color-burn hard-light soft-light difference exclusion hue saturation color luminosity add`. These follow CSS compositing; `add` is CSS `plus-lighter`. |
| `filters` | none | A list of `blur`, `glow` and `shadow` filters, applied in order. See 1.8. |
| `mask` | none | A node whose alpha limits where this node shows, optionally inverted. See 1.8. |
| `isolate` | false | Draw the node as one layer, so its opacity applies to the group as a whole. |

Node types:

- `shape`: a path track, an optional fill paint, an optional stroke, and a fill rule (`nonzero` or `evenodd`).
- `group`: a list of child nodes.
- `use`: draws `defs[ref]` with this node's fields applied on top. A def may only refer to defs with a smaller index, so references never loop.
- `text`: a string drawn with an embedded font. See 1.9.
- `image`: draws an image asset stretched over the rectangle `x, y, width, height` in local units.
- `video`: draws the current frame of a video asset over its rectangle the same way. The current frame is the latest frame whose time is at or before `t`.

All keyframe and frame times are absolute scene times, including inside defs.

### 1.3 Tracks and keyframes

A track holds either one constant value or a list of keyframes `(t, value, ease)`, sorted by `t`. Two keyframes may share a time; this makes an instant jump.

To sample a track at time `t`:

1. If `t ≤ t₀`, return the first value. If `t ≥ tₙ`, return the last value.
2. Find `i` with `tᵢ ≤ t < tᵢ₊₁`. If several keyframes share `tᵢ`, use the last of them.
3. Let `u = (t − tᵢ) / (tᵢ₊₁ − tᵢ)` and interpolate with keyframe `i`'s ease:

| Ease | Result |
|---|---|
| `linear` | `a + (b − a)·u` |
| `hold` | `a` |
| `ease`, `easeIn`, `easeOut`, `easeInOut` | CSS presets: cubic-bezier(.25,.1,.25,1), (.42,0,1,1), (0,0,.58,1), (.42,0,.58,1) |
| `[x1, y1, x2, y2]` | CSS `cubic-bezier()` timing function applied to `u`, then linear between `a` and `b` |
| `smooth` | Cubic Hermite through the keyframes. The tangent at keyframe `k` is `(v[k+1] − v[k−1]) / (t[k+1] − t[k−1])`, with indices clamped to the track. |

Values may be numbers, colors (four channels, interpolated per channel) or paths (every coordinate interpolated on its own). Sampling works for any real `t`, so playback can run at any frame rate with no extra data.

### 1.4 Paths

A path is a list of subpaths. A subpath has a start point, a list of segments and a `closed` flag. There are two kinds:

- **Explicit.** Each segment is a line to a point or a cubic Bézier with two control points and an end point. Quadratic curves and arcs are converted to cubics when authored.
- **Spline.** The subpath lists points only, each with a `corner` flag. The curve passes through every point. Between points `Pᵢ` and `Pᵢ₊₁` it is the cubic with handles `Pᵢ + (Pᵢ₊₁ − Pᵢ₋₁)/6` and `Pᵢ₊₁ − (Pᵢ₊₂ − Pᵢ)/6` (Catmull-Rom). A handle at a corner point collapses onto the point. Neighbor indices wrap on closed subpaths and clamp on open ones. Splines cost about half as much as explicit curves and suit traced outlines.

All keyframes of one path track must share a topology: the same subpaths, the same segment kinds and the same corner flags. Encoders make differing keyframes match before writing them. The reference encoder splits the longest segments, turns lines into cubics, adds empty subpaths, and rotates closed subpaths so their points line up.

### 1.5 Paint and strokes

- `solid`: a color track.
- `linear`: constant `from` and `to` points and a list of color stops.
- `radial`: constant `center`, `radius` and a list of color stops.

Stops have an offset in `[0, 1]` and an RGBA color. Gradient coordinates are in the shape's local units. Strokes have a paint, a width track, a join (`miter`, `round`, `bevel`) and a cap (`butt`, `round`, `square`).

### 1.6 Transforms

A transform has number tracks `x`, `y` (default 0), `rotation` in degrees (default 0), `scaleX`, `scaleY` (default 1) and a constant `anchor` point (default 0,0):

```
M = translate(x, y) · rotate(rotation) · scale(scaleX, scaleY) · translate(−anchor)
```

A child's matrix is its parent's matrix times its own. Stroke widths, filter radii and gradient geometry are in local units, so they scale with the transform.

### 1.7 Drawing

To draw time `t` into a `W × H` pixel target showing the scene rectangle `view` (default: the whole canvas):

1. Map `t` to scene time with the loop rule.
2. Scale `view` uniformly to fit the target and center it.
3. Fill the target with `background` if present.
4. Walk the nodes in order, skipping nodes outside their visibility window and multiplying matrices down the tree.

A node is drawn as a **layer** if it has filters, a mask or `isolate`, or if it is a group or `use` with a blend other than `normal`. Otherwise its opacity multiplies into its children and a leaf draws straight onto the target with its blend mode.

### 1.8 Layers, masks and filters

To draw a layer:

1. Draw its content onto a clear surface the size of the target.
2. If it has a mask, draw the mask node onto a second clear surface. The mask node sits in the masked node's local space and has its own transform and visibility. Keep the content where the mask has alpha (`destination-in`), or where it has none if `invert` is set (`destination-out`).
3. Apply the filters in order. `k` is the square root of the absolute determinant of the layer's full matrix, so radii scale with zoom.
   - `blur`: Gaussian blur with standard deviation `radius·k` pixels.
   - `glow`: blur the layer by `radius·k`, fill its alpha with `color`, draw that copy `strength` times (the last time with the fractional part as alpha), then draw the layer on top.
   - `shadow`: blur the layer by `radius·k`, fill its alpha with `color`, draw it offset by `(dx, dy)` mapped through the layer's matrix, then draw the layer on top.
4. Composite the surface onto its parent with the layer's opacity and blend mode.

### 1.9 Text

A text node has `text`, a `font` (index of a font asset), a `size` track, an `align` (`left`, `center`, `right`), an optional `letterSpacing` in local units and a `lineHeight` as a multiple of size (default 1.2). It may have a fill and a stroke like a shape.

A font asset holds `unitsPerEm`, `ascent`, `descent`, one outline per character (path in font units, y pointing down, baseline at 0), an advance per character and optional kerning pairs. Encoders store only the characters used.

Layout: split the text at `\n`. Within a line, each character advances by its advance width plus kerning with the next character (in font units, scaled by `size / unitsPerEm`) plus `letterSpacing`. A character the font lacks advances half an em and draws nothing. `align` shifts each line by none, half, or all of its width. Line `n` sits `n · lineHeight · size` below the first. The first baseline passes through the node's local origin. There is no complex-script shaping.

### 1.10 Media

- **Images** are stored as AVIF, WebP, PNG or JPEG files with their pixel size.
- **Video layers** are AV1 streams with a WebCodecs codec string and pixel size. Each frame is an AV1 temporal unit (low-overhead OBU format) with a time and a key flag. The first frame in every chunk must be a key frame that carries a sequence header, so a chunk decodes without the chunks before it.
- **Audio** is stored per chunk as self-contained segments, each a complete Ogg Opus file with a start time.

## 2. Quantization

| Quantity | Step |
|---|---|
| Coordinates, anchor, stroke width, gradient geometry, filter radius and offset, font size, letter spacing, media rectangle, canvas size | `2^precision` scene units |
| Glyph outlines and advances | 1 font unit |
| Time | `1 / timescale` seconds |
| Rotation | 1/256 degree |
| Scale | 1/4096 |
| Opacity | 1/255 |
| Glow strength | 1/256 |
| Color channel | 1 (0–255) |
| Gradient stop offset, bezier ease x | 1/255 |
| Bezier ease y | 1/255, signed |
| Line height | 1/256 |

The reference encoder picks `precision = floor(log2(max(width, height) / 32768))` for authored scenes, so coordinates are stored to about 1/32768 of the canvas. Its video tracer uses `precision = −2` (quarter pixels), which is finer than the tracer's own accuracy. The default `timescale` is 600, which divides 24, 25, 30, 50 and 60 exactly.

## 3. File layout

### 3.1 Container

| Part | Encoding |
|---|---|
| `53 56 56 02` | `SVV`, version 2 |
| header length, header | varint, then range-coded bytes (3.4) |
| table length, table | varint, then varints (3.2) |
| payloads | in table order, back to back |

Varints are unsigned LEB128. A player reads the first few kilobytes, parses the header and table, and then knows the byte range of every chunk and asset. It can fetch them with HTTP range requests, or read the file front to back while playing.

### 3.2 Table

```
varint count
per entry:
  varint kind
  kind 0, asset data:  varint asset, varint length
  kind 1, chunk:       varint start tick, varint end tick, varint dependency count, varint asset × count, varint length
```

Fonts and images are stored once, as asset entries, and each one comes before the first chunk that lists it as a dependency. Video frames and audio segments live inside chunks.

### 3.3 Chunks

A chunk covers scene time `[start, end)`. The chunk for time `t` is the last one whose start is at or before `t`. A chunk holds everything needed to draw its time range: the nodes visible in it, the defs they use, and every keyframe they need. Each track keeps one keyframe beyond the range on each side, which also covers `smooth` tangents. Tracks that are constant within the chunk become constants. A chunk never refers to data in another chunk, so a player can seek by fetching one chunk and its listed assets. The reference encoder makes 10-second chunks by default. Shorter chunks seek faster but repeat more data.

Chunk payload:

```
varint scene length, scene             range-coded, fresh state (3.4–3.6)
varint media group count
per group:
  varint asset, varint item count
  per item: varint tick, [video only: byte key flag], varint length, bytes
```

Asset payloads: images are the raw file bytes; fonts are range-coded (3.6, `font`).

### 3.4 Range coder

Every range-coded part (header, each chunk's scene, each font) starts a new coder with fresh probabilities. It is the binary range coder from LZMA with 11-bit probabilities:

- Encoder state: `low` (33 bits), `range` (32 bits, starts at `0xFFFFFFFF`), `cache` (starts at 0), `cacheSize` (starts at 1).
- A probability `p` is the chance of a 0 bit, out of 2048. Every probability starts at 1024.
- Coding bit `b` with probability `p`: `bound = (range >>> 11) · p`. If `b = 0`, `range = bound` and `p += (2048 − p) >> 4`. Otherwise `low += bound`, `range −= bound` and `p −= p >> 4`. While `range < 2^24`, shift `range` left by 8 and shift out one byte of `low` as LZMA does.
- Direct bits (probability fixed at one half): `range >>>= 1`; if the bit is 1, `low += range`; then normalize.
- On finish, the encoder shifts out 5 bytes, drops the first output byte (always 0) and drops trailing zero bytes.
- The decoder reads 4 bytes into `code` and treats missing bytes as zero. More than 8 missing bytes means the data is truncated.

### 3.5 Binarizations and back-references

Each named context has its own probability state; two fields with the same name share statistics. The names in 3.6 are part of the format.

- `bit(name)`: one coded bit.
- `symbol(name, n)`: an `n`-bit value sent most significant bit first through a binary tree of `2^n` probabilities.
- `uint(name)`: for `v ≥ 0`, let `w = v + 1` and `k = bitlength(w) − 1`. Send `k` in unary (`k` ones then a zero, one probability per position), then the low `k` bits of `w` from the top. The first two use probabilities indexed by `(k, position)`; the rest are direct bits.
- `sint(name)`: a "zero" bit; if nonzero, a sign bit (1 = negative) and `uint(|v| − 1)`, all under the same name.
- `count(name)`: a `uint` that decoders reject above 2^22 (or a smaller limit given in the syntax).
- `string(name)`: `uint name.n` bytes of UTF-8, each a `symbol(name, 8)`.

The coder keeps lists of recently used items: colors (64 entries) and, with 32 entries each, timings, animated number tracks (one list per property) and path tracks. A reference `r` is a `uint`. `r = 0` means a new item follows, which then goes to the front. `r > 0` reuses entry `r − 1` and moves it to the front.

### 3.6 Syntax

`q(v)` is `v` on its grid. Number track properties `P`, with grid and default: `x`, `y` (coordinates, 0), `rot` (1/256°, 0), `sx`, `sy` (1/4096, 1), `op` (1/255, 1), `sw` (coordinates, 1), `fs` (coordinates, 16), `fr`, `fdx`, `fdy` (coordinates, 0), `fk` (1/256, 1).

```
header:
  uint timescale (> 0), sint precision
  uint dim (width), uint dim (height), uint dur (ticks)
  bit loop, bit bg [color]
  uint audio                       0 = none, else asset + 1
  count assets (≤ 65536)
  per asset: symbol(asset, 2)      0 font, 1 image, 2 video, 3 audio
    image: symbol(img.mime, 2) (avif, webp, png, jpeg), uint img.w, uint img.h
    video: string codec, uint vid.w, uint vid.h
    audio: string codec, uint aud.rate, uint aud.ch

chunk scene:
  count defs, node × defs          def i may only use refs < i
  count nodes, node × nodes

color:
  uint color.idx                   back-reference
  if new: symbol(color.r, 8) symbol(color.g, 8) symbol(color.b, 8) symbol(color.a, 8)

timing:
  uint kf.ref                      back-reference
  if new:
    count kf.n                     keyframes − 1
    uint kf.t0
    if ≥ 3 steps: bit kf.mode
    per step i: mode 1 and i ≥ 2 ? sint kf.ddt (step − step[i−2]) : uint kf.dt
    per keyframe but the last: symbol(ease.<previous ease index, 0 at first>, 3)
      0 linear, 1 hold, 2 ease, 3 easeIn, 4 easeOut, 5 easeInOut, 6 smooth, 7 bezier
      bezier: symbol(ease.x, 8) sint ease.y symbol(ease.x, 8) sint ease.y

number track P:
  bit P.anim
  constant: sint P.v               q(value) − q(default)
  animated:
    uint P.ref                     back-reference into P's list
    if new:
      timing
      if ≥ 3 keyframes: symbol(num.pred, 2), predictor m ∈ {0, 1, 2}
      per keyframe i: sint (i ≥ 2 and m > 0 ? P.p<m> : P.d)   q(vᵢ) − predict(m, i)
        predict(m, 0) = q(default); predict(m, 1) = v₀
        predict(0, i) = vᵢ₋₁; predict(1, i) = 2vᵢ₋₁ − vᵢ₋₂; predict(2, i) = vᵢ₋₂

color track:
  bit color.anim
  constant: color
  animated: timing, color, then per later keyframe and channel sint color.d (change from previous)

paint:
  symbol(paint, 2)                 0 solid, 1 linear, 2 radial
  solid: color track
  linear: sint grad.p × 4; radial: sint grad.p × 2, uint grad.r
  gradients: count grad.n (stops − 1), per stop symbol(grad.off, 8) and color

fill and stroke:
  bit shape.fill [paint]
  bit shape.stroke [paint, number track sw, symbol(stroke.join, 2), symbol(stroke.cap, 2)]

path track:
  uint path.ref                    back-reference
  if new:
    bit path.anim [timing]
    topology, geometry (first keyframe)
    per later keyframe k:
      symbol(path.pred, 2) p, bit path.exact
      unless exact, per coordinate: sint path.r<p>   value − predict
        p = 0: same coordinate, keyframe k−1
        p = 1: 2·(k−1) − (k−2)
        p = 2: (k−1) + (this keyframe − keyframe k−1) at the coordinate two places back (p = 0 for the first two)
        p = 3: same coordinate, keyframe k−2
        p = 1 and p = 3 are invalid for k = 1

topology:
  count path.subs
  per subpath: count path.segs, bit path.closed, bit path.spline
    spline: per point (segs + 1) bit path.corner.<previous point is a corner>
    else:   per segment bit path.cubic.<previous segment is cubic>

geometry:                          current point starts at (0,0) and carries across subpaths
  per subpath: sint path.mx, sint path.my             start − current
  spline points: sint path.px, sint path.py           point − current
  lines:         sint path.lx, sint path.ly           end − current
  cubics:        sint path.cx, sint path.cy           end − current
                 c1 − prediction: after a cubic, 2·current − previous c2 (path.s1x, path.s1y);
                                  else round(current + (end − current)/3) (path.c1x, path.c1y)
                 sint path.c2x, sint path.c2y         c2 − round(end + (current − end)/3)
  round() sends halves toward +∞, as JavaScript's Math.round does.

transform:
  bit xf
  x, y, rotation: bit xf.<name> [number track]
  scaleX: bit xf.scaleX [number track]
  bit xf.uniform                   scaleY equals scaleX
  unless uniform: bit xf.scaleY [number track]
  bit xf.anchor [sint xf.ax, sint xf.ay]

node:
  symbol(node, 3)                  0 shape, 1 group, 2 use, 3 text, 4 image, 5 video
  bit node.start [uint node.t]     start tick
  bit node.end [uint node.t]       end − start in ticks
  bit node.op [number track op]
  transform
  bit node.fx
  if fx:
    bit fx.blend [symbol(fx.mode, 5)]   index in the list of 1.2
    bit fx.isolate
    count fx.filters (≤ 64)
    per filter: symbol(filter, 2)  0 blur, 1 glow, 2 shadow
      shadow: number track fdx, number track fdy
      all:    number track fr
      glow, shadow: color track
      glow:   bit glow.k [number track fk]
    bit fx.mask [bit mask.invert, node]
  group: count group.n, node × group.n
  use:   uint use.ref
  shape: bit shape.evenodd, path track, fill and stroke
  text:  uint text.font, string text.s, number track fs, symbol(text.align, 2),
         bit text.ls [sint text.lsv], bit text.lh [uint text.lhv = round(lineHeight · 256)],
         fill and stroke
  image, video: uint media.asset, sint media.x, sint media.y, uint media.w, uint media.h

font (asset payload, coordinates on a 1-unit grid):
  uint font.upm, sint font.asc, sint font.desc
  count font.n (≤ 65536)
  per glyph, by ascending code point: uint font.cp (change from previous), uint font.adv, topology, geometry
  uint font.kern, per pair: uint kern.a, uint kern.b (glyph indices), sint kern.v
```

## 4. Conformance

A decoder conforms if it reproduces the quantized scene exactly. Writing a decoded file back out with the same chunks must give the same bytes; the reference tests check this.

A renderer conforms if it follows 1.7 to 1.9. Anti-aliasing, the blur kernel's exact shape and color handling during compositing are up to the renderer, as with SVG and Canvas.

## 5. Converting video

`svv trace` turns an existing video into SVV:

1. Build a palette from flat areas of sampled frames (k-means).
2. Estimate global camera motion. If a textured background fits that motion, store it once as an AVIF image and move it with keyframes.
3. Per changed frame, label pixels by palette color, merge regions under 20 pixels into neighbors, and build stacked shapes. Each region also covers the smaller regions drawn on top of it, so neighbors meet without seams. Outlines come from marching squares, are smoothed, simplified, and stored as spline subpaths.
4. Link each shape to a shape of the same color in the previous drawing by shifting the old outline points onto the new outline. A linked shape becomes another keyframe of the same path track, coded as a prediction from earlier keyframes. Keyframes that linear interpolation reproduces within 0.3 px are dropped. Frames that repeat the previous drawing cost nothing.
5. For each chunk, measure the vector version's SSIM against the source. Then find the smallest AV1 encode that reaches the same SSIM, and keep whichever is smaller. A chunk that picks AV1 becomes a full-frame video layer.

## 6. Limits of version 2

- Shapes win only when the content is shapes. Traced footage with line boil, painted texture, film grain or soft 3D shading costs more as vectors than as AV1 at the same SSIM, and the tracer then stores it as AV1. [BENCHMARKS.md](BENCHMARKS.md) shows where each kind of clip lands.
- Text has kerning but no complex-script shaping or ligatures.
- Filters are blur, glow and drop shadow. There are no displacement, color-matrix or other filters, and no 3D.
- Layers are drawn at the size of the whole target, which costs fill rate when many layers overlap.
- Audio segments are cut per chunk, so a player may click at chunk boundaries.
- Browsers without WebCodecs AV1 decoding (some Safari versions) cannot show video layers; everything else still draws.
