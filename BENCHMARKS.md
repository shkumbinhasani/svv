# SVV vs animated AVIF

`bun run bench` reproduces these numbers. It needs `ffmpeg` with `libsvtav1`, `libdav1d` and `libopus`. Results land in `out/bench/results.json`.

## The five test clips

All clips are 1280×720 at 24 fps, 5 to 6 seconds long.

| Clip | What it is | How it was made |
|---|---|---|
| Motion graphics | Title sequence: embedded-font text revealed by a moving mask, glowing underline, blurred bokeh in `screen` blend, additive light sweep, gradient background | Written as an SVV scene (`examples/scenes/titles.ts`) |
| Rigged cut-out character | Puppet with nested limbs, head bob, blinking, eyes that look around through a mask, swapping mouth shapes, drop shadow, parallax hills, glowing sun | Written as an SVV scene (`examples/scenes/cutout.ts`) |
| Hand-drawn frame by frame | Ink-outlined character walking and waving, bouncing ball, swaying plant; drawn on twos with line boil (every drawing jittered by hand-like wobble) | Raster video from `bench/clips/handdrawn.ts` |
| Anime style, painted background | Painted panorama (soft clouds, textured hills, 9,000 grass strokes, film grain) panning 1.7 px per frame; two cel-shaded characters animated on threes; falling petals on twos | Raster video from `bench/clips/anime.ts` |
| 3D-rendered toon | Ray-traced spheres and a rotating box with three-band toon shading, cast shadows, ink outlines, gradient sky; camera orbits so every frame changes | Raster video from `bench/clips/toon3d.ts` |

The raster clips are stored losslessly (FFV1, RGB). The tracer sees only their pixels.

## Method

1. **Make the SVV file.** Vector clips are encoded as written. Raster clips go through `svv trace` in its default `auto` mode. That traces the video into linked vector shapes, measures that version's SSIM against the source, and finds the smallest AV1 encode that reaches the same SSIM (never below 0.97). Each chunk keeps whichever is smaller.
2. **Measure SVV.** Decode the file, draw every frame at 1280×720, and compute SSIM and PSNR against the source in yuv420p.
3. **Find the matching AVIF.** Binary-search SVT-AV1's CRF (preset 4, one keyframe, yuv420p) for the smallest file whose SSIM is at least SVV's. Wrap that stream in an AVIF image sequence with ffmpeg and count the whole file. When no CRF reaches SVV's SSIM, report CRF 63, the smallest AVIF the encoder makes.

Both formats get the same seek points: one key frame per clip, since every clip is shorter than SVV's 10-second chunk.

Frames are compared by index. (An earlier version of this benchmark compared IVF files by timestamp, which paired the wrong frames and understated AVIF's quality. Its sizes were right, but its SSIM column was wrong.)

## Results

| Clip | SVV | SVV SSIM | AVIF at that SSIM | AVIF / SVV | What SVV stored |
|---|---:|---:|---:|---:|---|
| Motion graphics | **3.6 KB** | 0.99995 | not reachable; smallest AVIF is 16.4 KB at SSIM 0.9941 | **4.6×** | shapes, text, effects |
| Rigged cut-out character | **1.2 KB** | 0.999997 | not reachable; smallest AVIF is 23.1 KB at SSIM 0.9919 | **19.4×** | shapes and rig |
| Hand-drawn frame by frame | **28.4 KB** | 0.9967 | 29.6 KB (CRF 63) | 1.04× | AV1 layer |
| Anime style, painted background | **227.5 KB** | 0.9706 | 228.7 KB (CRF 43) | 1.01× | AV1 layer |
| 3D-rendered toon | **24.0 KB** | 0.9888 | 25.2 KB (CRF 63) | 1.05× | AV1 layer |

SVV is no larger than AVIF at the same SSIM on all five clips.

- **Made as vectors**, SVV wins outright. Even AVIF's lowest setting is several times larger and visibly worse, and no AVIF setting reaches SVV's quality: 3.2 MB at CRF 1 still scores below it. The SVV file also plays at any resolution and frame rate; AVIF would need a new encode for each.
- **Converted from pixels**, SVV ties AVIF. In all three cases the tracer found AV1 cheaper than its own vectors and stored AV1 inside SVV. The remaining 1 to 5 percent gap is container overhead: SVV spends about 670 bytes on this, AVIF about 1.9 KB.

## What the tracer's vectors cost

The vector versions the tracer rejected:

| Clip | Vector SVV | Vector SSIM | AV1 at that SSIM or better | Why vectors lose |
|---|---:|---:|---:|---|
| Hand-drawn | 98 KB | 0.9962 | 28 KB (SSIM 0.9967) | Line boil redraws every outline in every drawing. The tracer links 62% of shapes across drawings, but each still needs new points. |
| Anime | 349 KB | 0.9444 | 232 KB (SSIM 0.9717) | The painted plate costs 43 KB alone. Grain and soft edges don't survive palette quantization, and the foreground changes every frame because of the pan. |
| 3D toon | 173 KB | 0.9839 | 24 KB (SSIM 0.9889) | The gradient sky splits into palette bands, thin anti-aliased outlines turn into slivers, and perspective reshapes every outline every frame. |

These are the cases AV1 is built for: small changes between frames that motion prediction handles cheaply, and soft detail that a tracer can only approximate with many shapes. Tracing pays off only when the source pixels really are flat shapes with stable outlines. The better path is to export animation from the tool that made it (rigs, layers and keyframes) rather than trace rendered pixels; that's the "made as vectors" row.

## Playback speed

`bun run perf` plays each file for four seconds in a Chrome window and counts the frames it shows. The canvas fills a 1280×720 CSS box at a device pixel ratio of 1 and of 2.

| File | Canvas | Frames shown per second | Main-thread draw time per frame |
|---|---|---:|---:|
| Motion graphics | 1280×720 | 58 | 0.5 ms |
| Motion graphics | 2560×1440 | 60 | 0.4 ms |
| Rigged cut-out character | 2560×1440 | 60 | 0.6 ms |
| Confetti, 300 particles | 2560×1440 | 60 | 0.7 ms |
| Landscape | 2560×1440 | 60 | 0.3 ms |
| Hand-drawn (AV1 layer) | 2560×1440 | 60 | 0.5 ms |

The display ran at 60 Hz, so 60 is the ceiling. Runs that show 58 lost a frame or two while the file loaded.

## Older measurements

Version 1's examples, encoded with version 2's 10-second chunks:

| Scene | SVV |
|---|---:|
| logo, 4 s | 775 B |
| morph, 6 s | 2,256 B |
| chart, 6 s | 1,463 B |
| landscape, 10 s | 1,139 B |
| confetti, 6 s, 300 particles | 7,565 B |

Version 1's AVIF sizes for these at 1080p30 CRF 35 were 82 KB to 1.6 MB, and they still hold.
