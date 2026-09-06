# Kaleidoscope

A high-FPS WebGL2 kaleidoscope **simulation** — not a shader that fakes the
symmetry, but the two things a kaleidoscope is actually made of:

- **An object cell.** The shallow disc of loose coloured glass at the far end of
  the tube, simulated as rigid discs on a fixed 180 Hz timestep with a
  counting-sort broadphase. Gravity is fixed in the world and the cell turns
  with the tube, so rolling it makes the pile slide — which is the entire feel
  of holding one.
- **A mirror tube.** Four real tubes: the two-mirror V that makes a rosette, and
  the three three-mirror tubes whose reflections tile the plane without a seam
  (3·3·3, 2·3·6, 2·4·4). Mirrors are not free — each bounce costs a few percent
  of the light and warms it slightly, which is where the falloff toward the rim
  comes from.

Rendered in two passes: one instanced draw puts every shard into an offscreen
texture, and one full-screen triangle folds the view into the tube's
fundamental domain and samples it.

## What can be in the cell

The glass is the default, not the limit. One 27-vertex fan, reshaped per
instance in the vertex shader, covers every one of these in a single draw:

- **Glass chips** — mixed 3- to 8-sided polygons, the original jar.
- **Stars**, **slivers** (needles of glass), and a **confetti mix** of all three.
- **Text and emoji.** Type anything into the box — letters, digits, `∫≈≠`,
  🔮💎🌸 — or load a preset. The characters are rasterised once into a glyph
  atlas and each shard samples its own cell of it, so 2400 tumbling emoji cost
  the same draw call as 2400 hexagons. Emoji can keep their own colours or take
  the palette's.

Sixteen palettes: the original jars, three colourblind-safe swatch sets
(Okabe–Ito, Tol bright, Tol muted) and six continuous **gradient ramps**
(Viridis, Magma, Cividis, Sunset, Spectrum, Duotone) where each shard's colour
is a point on the ramp rather than one of eight bins. The **Vision** control
simulates protanopia, deuteranopia, tritanopia and achromatopsia on the
finished image, so a palette can be checked rather than taken on trust.

## What can be behind it

The object cell of a real kaleidoscope is lit from behind through a frosted
plate. Swap the plate for a picture and the glass multiplies over it and the
mirrors fold the result:

- **Camera** — a teleidoscope: whatever is in front of you, through the tube.
- **Screen or tab** — share a tab and it goes through the mirrors live.
- **An image or a video** — pick one, or drop it anywhere on the page.

**Not YouTube, and not by oversight.** An embed is a cross-origin iframe and no
browser lets a page read pixels out of one; the player is DRM-fenced besides.
Share the tab playing the video instead — that is the same picture and it
works. (The camera also needs a `Permissions-Policy` change on the droplet
before it will work on the live site; see `DEPLOY.md`.)

**Live: https://kaleidoscope.lab980.com**

## Controls

| | |
|---|---|
| drag | roll the tube |
| wheel / pinch | field of view |
| click | shake the cell |
| `1`–`4` | mirror tube |
| `s` | cycle the shard shape |
| `space` | shake · `r` refill · `p` pause |
| `h` | hide the chrome · `f` fullscreen |

## Frame rate

The HUD reports mean frame time, the 99th-percentile frame time (the stutters a
mean hides), GPU time where `EXT_disjoint_timer_query_webgl2` is available, and
the CPU cost of the sim. Adaptive scale holds a target frame rate by moving the
render scale in small steps — deliberately small, because a resolution that
chases every dip is more distracting than the dip.

There is no frame cap: the loop is one `requestAnimationFrame` with nothing
throttling it, so on a high-refresh display it runs at the display's rate.

## Running it locally

No build, no dependencies — but it uses ES modules, so it needs a server rather
than `file://`:

```bash
python3 -m http.server 8080   # then open http://127.0.0.1:8080/
```

Deploying is a separate step on the lab980 droplet; see `DEPLOY.md`.
