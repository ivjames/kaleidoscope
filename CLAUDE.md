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

Four files, no bundler, no dependencies. `index.html` is the shell and the
controls; the rest are ES modules loaded straight from `js/`.

| file | what it owns |
|---|---|
| `js/cell.js` | the object cell — the disc of tumbling glass. Rigid-disc sim, counting-sort broadphase, fixed 180 Hz timestep. Pure CPU, no GL. |
| `js/shaders.js` | the two GLSL ES 3.00 programs, as strings. |
| `js/renderer.js` | WebGL2: FBO, instancing, blend state, the mirror-tube geometry, GPU timing. |
| `js/main.js` | frame loop, controls, input, frame-rate metrics, adaptive scale. |

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
- **`index.html` carries the `BUILD` constant** at two-space indentation, which
  is what `kaleidoscope deploy` stamps and `kaleidoscope status` reads back.
  Keep it on its own line in that form or the stamp silently stops working.
- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). A static site has no
  `.env` and no secrets to hold.
- Frame-rate work is the point of the piece, so keep the loop allocation-free:
  the sim options, the tube options and the metrics buffers are all hoisted and
  reused. A per-frame object literal is how a clean 240 fps becomes a sawtooth.
