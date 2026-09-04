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

**Live: https://kaleidoscope.lab980.com**

## Controls

| | |
|---|---|
| drag | roll the tube |
| wheel / pinch | field of view |
| click | shake the cell |
| `1`–`4` | mirror tube |
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
