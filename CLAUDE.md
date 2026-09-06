# Kaleidoscope — working notes

A high-FPS WebGL2 kaleidoscope simulation — a physical mirror tube and tumbling object cell, rendered on the GPU.

Served at **https://kaleidoscope.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

Fully **static**: the site is files served straight by nginx. No build step,
no app process, no local port, no pm2, no database. nginx serving the git
checkout *is* the deployment, so "what's on `main`" and "what's live" differ
only by a `git reset` on the droplet.

- Repo: `ivjames/kaleidoscope` · droplet checkout: `/var/www/kaleidoscope` (the web root)
- Operate CLI: `bin/kaleidoscope`, symlinked to `/usr/local/bin/kaleidoscope`
- vhost: generated from `deploy/nginx.conf.template` by `kaleidoscope setup`

## Deploying

On the droplet, as root:

```bash
kaleidoscope deploy      # git fetch + reset --hard origin/main (+ build stamp)
kaleidoscope status      # HEAD, live probe, cert days remaining
```

Full runbook, including first-time bring-up: `DEPLOY.md`.

Checking what is actually live, concretely for this site — `kaleidoscope status`
on the box, or from anywhere:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://kaleidoscope.lab980.com/
curl -s https://kaleidoscope.lab980.com/ | grep -o "const BUILD = '[^']*'" | head -1
```

(The second line reports nothing if the page carries no `BUILD` constant — see
the deploy stamp note in `DEPLOY.md`. `head -1` because a page that polls its
own build stamp carries a matching regex literal, which grep otherwise reports
as a phantom second build.)

## What the code is

Six files, no bundler, no dependencies. `index.html` is the shell and the
controls; the rest are ES modules loaded straight from `js/`.

| file | what it owns |
|---|---|
| `js/cell.js` | the object cell — the disc of tumbling glass. Counting-sort broadphase, contacts taken against each shard's real outline, a relaxation solver on a fixed 180 Hz timestep, and the fill cap that bounds how much glass the chamber holds. Also the palettes and the shape modes. Pure CPU, no GL. |
| `js/shaders.js` | the three GLSL ES 3.00 programs, as strings. |
| `js/renderer.js` | WebGL2: FBO, instancing, blend state, the three textures, the mirror-tube geometry, GPU timing. |
| `js/glyphs.js` | rasterises a character set into the glyph atlas, with canvas2D. No GL — it hands the renderer a canvas. |
| `js/media.js` | the backdrop sources: camera, screen share, dropped file. Owns the stream and the video element, not the texture. |
| `js/main.js` | frame loop, controls (including the Shards ceiling, which tracks shard size), input, frame-rate metrics, adaptive scale. |

The render is two passes: the cell is drawn once into an offscreen square
texture (one instanced draw for every shard), then a single full-screen
triangle folds view coordinates into the mirror tube's fundamental domain and
samples that texture. That is what a kaleidoscope physically is, and it means
raising the window size costs one cheap pass instead of two.

## Things worth knowing

- **It needs WebGL2.** There is no canvas2D fallback: the whole design is one
  instanced draw plus one fold, and a fallback would be a different program.
  A browser without it gets the error on the boot screen, by design.
- **Two mirrors and three mirrors are not the same picture.** A two-mirror V
  makes a rosette — a ring of sectors, the toy-kaleidoscope look. A three-mirror
  tube *tiles the plane*, and only three tubes tile it without a seam: the
  triangles with angles summing the Euclidean way (3·3·3, 2·3·6, 2·4·4). All
  four are in `TUBES` in `js/renderer.js`; adding a fourth triangle is not a
  free parameter, it is a different geometry.
- **The triangle fold sweeps all three mirrors per pass, not the worst one.**
  Reflecting only across the mirror the point is furthest beyond is the obvious
  greedy version and it does not reliably converge — it ping-pongs between two
  mirrors and leaves far-out points unfolded, which shows on screen as flat
  unresolved patches in the corners at a wide field of view.
- **Shards collide as their shapes, not as circles.** `_support(i, θ)` in
  `js/cell.js` returns how far a shard's outline actually reaches in a world
  direction — exact for all four families, because polygon and star are a walk
  over the same chords `SHARD_VS` draws and sliver and glyph are a rectangle in
  the shard's own frame. The contact test is then
  `d < support(i, θ) + support(j, θ+π)`; the bounding circles survive only as
  the cheap reject that gets a pair as far as that test, and `_walls` uses the
  same call, so a sliver lying flat reaches the chamber wall and end-on stands
  off it. Full convex-polygon contact — SAT, clipped manifolds, two-point
  contacts — is the heavier and different sim this deliberately is not: this
  one is exact along the contact normal and pays its trig only for the pairs
  the circles already accepted. `_resolveShapes` holds the geometry that both
  `_support` and `packStyle` read, so the picture and the physics cannot
  disagree about what a shard is.
- **Spin is not cosmetic, and that is exactly why it still needs a leash.** A
  shard's angle decides its support radius, so it decides where its neighbours
  touch it, and a contact landing off its centre line turns it
  (`SHAPE_TORQUE`) — which is what makes a sliver end up lying flat against a
  neighbour instead of balancing on a corner. That feedback is weak, though,
  and it is not what runs spin away: grazes and the scrape along the chamber
  wall are, and with the old coupling they took a settled cell to a mean near
  2 rad/s with peaks around 8, which is not glass tumbling, it is a blur. A
  weaker `SPIN_COUPLE` and a faster `SPIN_DECAY` hold it down now, every spin
  input is weighted by `spinInertia` (a big statement piece barely turns, which
  is most of what "too fast" looks like), and the Tumble slider scales the lot
  — 0 stops rotation dead without freezing the pile. `SHAPE_TORQUE` is one more
  way for contacts to pump it, so the test matters more than it used to, not
  less: check a change to any of it against spawn-vs-settled, and if settled is
  much higher, contacts are pumping again.
- **The chamber is a disc of fixed size, so only so much glass fits in it.**
  `FILL_LIMIT` is the fraction of its area the shards may cover — 0.85, past
  random loose packing because a jar of glass *is* packed, but short of where
  the relaxation passes stop converging — and `maxCountForSize` turns that into
  the largest count that fits at the current shard size. It is what the Shards
  slider's maximum tracks, so raising Shard size lowers the ceiling. The slider
  used to run to 2400 at any size, which at the default size is roughly sixteen
  times over: the solver was being asked to unpick a pile with no solution, and
  that is what the twitching and the overlapping were. Contacts are relaxed in
  up to three passes per substep (`solverIters` tapers to one as the count
  rises, to keep the cost bounded), with the velocity impulses on the first
  pass only so a dense pile is unpicked without being damped into treacle — and
  none of that converges on a pile that cannot fit in the first place.
- **Agitation scales with `sqrt(h)`, not `h`.** It is a random walk on
  velocity, so only the square root of the step keeps its per-second amplitude
  the same at any step rate. Scaled with `h` the slider's whole range summed to
  far less than gravity, which is why it read as a control that did nothing.
- **Every shard shape comes out of one 27-vertex fan.** `SHARD_VS` decides per
  instance where each rim vertex lands: an n-gon, a star (twice the corners,
  every other one pulled in), a sliver (a quad squashed on one axis), or a
  glyph quad carrying atlas UVs. Shapes with fewer corners than the fan has
  vertices emit repeats, i.e. degenerate triangles the rasteriser drops. Adding
  a shape means a new branch there and a new family number in `packStyle`, not
  a second draw call.
- **Glyph mode is exclusive on purpose.** The atlas fetch is behind a *uniform*
  branch (`uGlyph`), so it costs nothing in the other modes. Mixing glyphs into
  the confetti mix would make that a per-shard branch on a texture read, which
  is the one thing in this pass that would actually show up in the frame time.
- **The backdrop is the backlight, not a layer.** Camera, screen share and
  uploaded files are swapped into pass one's frosted plate, so the glass
  multiplies over them and the mirrors fold the result — a picture composited
  *after* the fold would be a different, and much less interesting, program.
  A video uploads once per decoded frame (via `requestVideoFrameCallback`), not
  once per rendered frame, and after the first frame it is a `texSubImage2D`
  into storage that already exists.
- **YouTube cannot be read by a page, and this is not a gap to fill.** An embed
  is a cross-origin iframe: `texImage2D` on one throws, and the player is
  DRM-fenced besides. The working route is the screen share — start it and pick
  the tab. Nothing about that will change, so don't take another run at it.
- **The camera is blocked in production by a header this repo does not own** —
  the shared lab980 `Permissions-Policy` sets `camera=()`. See `DEPLOY.md`;
  screen share and file upload are unaffected.
- **The backdrop is never persisted.** Everything else in the control panel is
  saved to localStorage; a reload must not reach for the camera on its own, and
  a dropped file's object URL died with the session.
- **The control panel folds; it does not scroll.** Its four sections are
  `<details>`, the body collapses into the title bar, and the HUD collapses to
  the bare frame count — so the panel fits on the screen at any setting instead
  of growing a scrollbar over the picture. Shake, Refill, Pause and Reset live
  in a permanent action bar outside the folding sections, because they are the
  ones you reach for while watching the glass rather than while reading the
  panel.
- **`index.html` carries the `BUILD` constant** at two-space indentation, which
  is what `kaleidoscope deploy` stamps and `kaleidoscope status` reads back.
  Keep it on its own line in that form or the stamp silently stops working. It
  is shown in the panel's title bar, which is the half that survives the fold.
- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). A static site has no
  `.env` and no secrets to hold.
- Frame-rate work is the point of the piece, so keep the loop allocation-free:
  the sim options, the tube options and the metrics buffers are all hoisted and
  reused. A per-frame object literal is how a clean 240 fps becomes a sawtooth.
