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
| `js/glyphs.js` | rasterises a character set into the glyph atlas, with canvas2D, and measures how much of each cell the ink actually covers. No GL — it hands the renderer a canvas. |
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
- **Every bit of rotation in the cell is something a contact did.** Nothing
  hands a shard spin from outside: a piece of glass is not born spinning, and
  a shake is a push rather than a twist — shaking a real tube throws the pile
  about, it does not reach in and turn each chip. The only two sources are in
  `_pair` and `_walls`: `SPIN_COUPLE`, the tangential slip of a graze or a
  scrape along the chamber wall, and `SHAPE_TORQUE`, a push landing off a
  shard's own centre line, which is what makes a sliver rotate until it lies
  flat against a neighbour instead of balancing on a corner. That second one
  only exists because contacts are taken against the outline, so the shard's
  angle decides where its neighbours touch it.
  Emergent spin is also self-limiting in a way an injected one was not, since
  a piece turning against its neighbours is doing work on them. What is left
  is a `SPIN_DECAY` for drag, a `spinInertia` weighting so a big statement
  piece barely turns (which is most of what "spinning too fast" looks like),
  a `MAX_SPIN` that is a numerical guard rather than a feature, and the Tumble
  slider scaling the lot — 0 stops rotation dead without freezing the pile.
  The test for a change to any of it: start from rest and watch the mean at
  five seconds against twenty. Contacts should spin most of the cell up and
  then hold it there; if twenty is much higher than five, they are pumping.
- **Mass comes off the outline too, not the bounding circle.** `areaK` is how
  much glass is actually inside a shard's outline per unit of radius², and a
  contact weights the two shards by it. Without that a needle shoulders a chip
  aside on the strength of a circle it barely fills — a sliver averages 0.45
  against a disc's π.
- **Three separate ceilings on the shard count, and only one is physics.**
  `shardCeiling` takes the smallest, and tells the caller which one bit so the
  panel can say so — "the chamber is full" in front of an obviously sparse cell
  reads as a bug.
  `fitsInChamber` is the geometry: `FILL_LIMIT` of the disc's area, divided by
  the mean *outline* area rather than the bounding circle. That distinction sets
  the constant — 0.62, not the 0.85 that was right while this counted circles,
  because 0.85 of the chamber in real glass is past where randomly oriented
  pieces jam. Measured across chips and glyphs, 0.62 settles to a median contact
  depth of about 2%, and it leaves the chips ceiling on the 140 it has always
  had, so counting glass rather than circles does not quietly densify the
  default cell; it only stops under-filling for everything that is not round.
  A disc fills its own circle, an emoji about a third of one, a sliver a
  seventh, and counted as circles a chamber "full" of emoji held a quarter of
  its area in glass.
  `settlesUnder` is numerics, and it is about **gravity**, not count. A
  relaxation pass carries a correction one contact deep, so a pile fails when
  the weight on its lower layers outruns the passes. Measured at shard size 0.4,
  a cellful of 1500 settles to a median overlap of 0.0% at zero gravity and 23%
  at the default: floating glass has no stack to crush, so it can be far finer.
  The curve is fitted to hold roughly five percent at the ceiling across the
  range — 600 at rest, 300 at the default — and floored so winding gravity to
  the top thins the cell rather than emptying it.
  `COST_LIMIT` is frame time, flat, and cares about none of the above. At shard
  size 0.4 the sim costs about 2 ms a frame at 300 shards, 5 at 600, 19 at 1500
  and 47 at 2400. It is what makes the old 2400 slider indefensible: at zero
  gravity the solver handles 2400 perfectly well, it simply cannot be afforded —
  and the adaptive scale cannot help, because that moves render resolution and
  this is CPU.
  Contacts are relaxed over `solverIters` passes per substep — three, dropping
  to two past 180 shards to bound the cost — with the velocity impulses on the
  first pass only, so a dense pile is unpicked without being damped into
  treacle. Past three the returns are poor and the cost is linear.
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
- **A glyph collides as its ink, not as its atlas cell.** The cell has to carry
  a margin — bilinear filtering and the mipmaps both reach past a cell's own
  texels — and a character rarely fills what is left: an emoji covers about 45%
  of its cell's area, a capital 19%, a `1` 9%, a full stop 1%. Drawn as the
  whole cell, the quad *is* the contact rectangle, so a cellful of text held
  itself apart by boxes several times the size of anything visible. `buildAtlas`
  measures each glyph's ink off the rasterised pixels — `measureText` is not
  reliable for a colour emoji — symmetrically about the cell centre, and the
  quad shrinks to that box and takes its atlas uv in with it. The character is
  drawn at exactly the size it always was; only the empty space around it goes.
  The same two numbers are the rectangle `_support` collides with, so the two
  cannot drift apart. That is also why `buildAtlas` centres a glyph on its ink
  rather than on the text origin: with `textBaseline` middle a descender or a
  tall cap sits a few percent off centre, which both wastes the box and makes
  the shard spin about a point that is not the middle of what you can see.
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
- **`touch-action: none` belongs on the canvas, not on the body.** The canvas
  needs it — a drag across it rolls the tube and must not pan the page — but the
  allowed gestures for a touch are intersected all the way up the ancestor
  chain, so putting it on `<body>` governed every control in the panel too. On
  iOS that is not a subtlety: WebKit's tap-to-click synthesis rides on the same
  gesture recognizer, so every button in the app lit up under a finger and then
  did nothing, while the sliders and the pickers — which never needed a
  synthesised click — worked fine and made it look like a few controls were
  broken rather than all of them. It also stopped the panel's own scroller from
  scrolling by finger, which on a short screen hid most of the panel with no way
  to reach it. Nothing reproduces this in a headless browser: a synthetic tap
  goes straight to the click, gesture recognizer or no.
- **The keyboard hints are for keyboards.** `#keys` is hidden on a coarse
  pointer, not merely on a narrow one — an iPad in landscape is about 1200px,
  so a width query left a list of keys that device does not have sitting over
  the picture. Touch also gets bigger hit areas, by growing the containers
  rather than letting a control's padding spill out of them: a hit area that
  overflows its parent is painted over by whatever comes next, so the bottom
  half of an "enlarged" button quietly does nothing.
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
