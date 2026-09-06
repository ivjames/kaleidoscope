// The object cell — the disc-shaped chamber of loose coloured glass at the far
// end of the tube. Everything a kaleidoscope actually *does* happens because
// this stuff moves: rolling the tube slides the pile, and the mirrors turn
// whatever it settles into a pattern.
//
// It is a 2D rigid-disc sim with a counting-sort broadphase, run on a fixed
// timestep so the picture behaves the same at 60 fps and at 300. All state is
// in flat typed arrays and the per-frame instance upload writes straight into a
// pre-allocated Float32Array, so a step allocates nothing.

// Two kinds of palette. A SWATCH palette is a jar of glass: a handful of
// discrete colours, and every shard is one of them, which is what a real object
// cell is. A RAMP is continuous — the shard's draw indexes a gradient rather
// than a bin — so the cell grades instead of speckling, and no two neighbouring
// chips are quite the same colour.
//
// The three marked CVD-safe are the standard ones: Okabe-Ito, and Paul Tol's
// bright and muted sets, all chosen so the hues stay distinguishable under
// protan and deutan vision. Cividis and Viridis are the same idea for a ramp.
// The Vision control in the mirror-tube panel simulates the deficiency, so a
// palette can be checked rather than taken on trust.
export const PALETTES = [
  { name: 'Stained glass', colors: ['#E23B4B','#F0A32A','#F5DE58','#3FA34D','#2E7BD1','#7B4BC4','#E0592C','#26B5A6'] },
  { name: 'Ember',         colors: ['#FF3B2F','#FF7A18','#FFB627','#F5E663','#C1272D','#7A1B12','#FF9E5E','#FFD9A0'] },
  { name: 'Ice',           colors: ['#8FE3F5','#4AA8FF','#2D6FD1','#B6F0E4','#5FD6C0','#D8E9FF','#7C89F0','#A5F3FF'] },
  { name: 'Neon',          colors: ['#FF2D95','#00F0FF','#B4FF39','#FFE600','#8A2BE2','#FF6B00','#00FF9C','#FF4FD8'] },
  { name: 'Botanical',     colors: ['#3E7C42','#7FB069','#C9DE8C','#E4B363','#A0522D','#5B8C5A','#D9CB9E','#2F5D50'] },
  { name: 'Smoke',         colors: ['#F0EDE8','#C9C5BE','#9B9B9B','#6E6E6E','#4A4A4A','#2C2C2C','#D8D2C8','#7F8B96'] },
  { name: 'Confetti',      colors: ['#FF5D8F','#FFC145','#5BC0EB','#9BC53D','#C3A6FF','#FF8C42','#4ECDC4','#F7F0E8'] },
  { name: 'Okabe–Ito · CVD safe',  colors: ['#E69F00','#56B4E9','#009E73','#F0E442','#0072B2','#D55E00','#CC79A7','#EDEDED'] },
  { name: 'Tol bright · CVD safe', colors: ['#4477AA','#EE6677','#228833','#CCBB44','#66CCEE','#AA3377','#BBBBBB','#EE8866'] },
  { name: 'Tol muted · CVD safe',  colors: ['#332288','#88CCEE','#44AA99','#117733','#999933','#DDCC77','#CC6677','#882255'] },
  { name: 'Viridis · ramp',        kind: 'ramp', colors: ['#440154','#46327E','#365C8D','#277F8E','#1FA187','#4AC16D','#A0DA39','#FDE725'] },
  { name: 'Magma · ramp',          kind: 'ramp', colors: ['#000004','#1D1147','#51127C','#822681','#B63679','#E65164','#FB8861','#FEC287','#FCFDBF'] },
  { name: 'Cividis · CVD ramp',    kind: 'ramp', colors: ['#00224E','#123570','#3B496C','#575D6D','#707173','#8A8779','#A69D75','#C4B56C','#E1CC55','#FEE838'] },
  { name: 'Sunset · ramp',         kind: 'ramp', colors: ['#0D1B4C','#452B72','#8B3A78','#C74E63','#EE7B4A','#FBB03B','#FFE08A'] },
  { name: 'Spectrum · ramp',       kind: 'ramp', colors: ['#FF0040','#FF8A00','#F5E100','#39D353','#00C2C7','#2D6BFF','#8A2BE2','#FF0080'] },
  { name: 'Duotone · ramp',        kind: 'ramp', colors: ['#12D8FA','#3B7BF5','#7A4BE0','#C13AC1','#FF4E88'] },
];

// The four shapes a shard can be. 'chips' is the original mixed n-gon jar;
// 'glyphs' is exclusive because the shard shader takes a uniform branch on it
// (a per-shard branch on a texture fetch is the one thing in this pass that
// would actually cost something).
export const SHAPES = [
  { id: 'chips',   name: 'Glass chips' },
  { id: 'stars',   name: 'Stars' },
  { id: 'slivers', name: 'Slivers' },
  { id: 'mixed',   name: 'Confetti mix' },
  { id: 'glyphs',  name: 'Text & emoji' },
];

const CELL_R = 1.0;          // the chamber is the unit disc; the FBO is its bbox
const MAX_RESTITUTION = 0.35;

// --- how fast the glass turns -----------------------------------------------
//
// Spin is purely cosmetic here: the shards collide as discs, so a shard's angle
// feeds nothing back into the physics. That is exactly why it needed reining
// in — nothing in the sim was pushing back on it.
//
// Every graze and every scrape along the chamber wall adds spin, and with the
// old coupling that pumped a settled cell up to a mean of ~2 rad/s with peaks
// near 8 (over a turn a second), which is not glass tumbling, it is a blur.
// Three things hold it down now: a much weaker coupling, a faster decay, and
// SPIN_INERTIA below.
const SPIN_COUPLE = 0.13;    // spin picked up per unit of tangential slip
const SPIN_DECAY = 2.6;      // e-folds per second once nothing is touching it
const SPIN_KICK = 2.6;       // the impulse a shake delivers
const SPIN_SPAWN = 1.2;      // the drift a shard is born with
const MAX_SPIN = 3.5;        // hard ceiling, rad/s, before the size weighting

// A big statement piece has far more angular inertia than a chip, so the same
// graze should barely turn it — and the big pieces are the ones the eye tracks,
// so they are most of what "spinning too fast" means. Weight every spin input
// by this, computed once per shard from its radius before the size slider (the
// slider scales the whole jar for looks; it should not change how the pile
// behaves). Normalised so a mid-sized chip sits at 1.
const SPIN_REF_R = 0.045;
function spinInertia(baseR) {
  const k = baseR / SPIN_REF_R;
  return 2 / (1 + k * k);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Parsed palettes are cached on the palette object: _applyPalette runs on every
// count change too, and re-parsing thirty hex strings each time a slider moves
// is exactly the sort of thing that shows up as a sawtooth in the frame graph.
function paletteRgb(p) {
  if (!p._rgb) p._rgb = p.colors.map(hexToRgb);
  return p._rgb;
}

function rampAt(stops, t) {
  const n = stops.length - 1;
  const x = Math.max(0, Math.min(0.999999, t)) * n;
  const i = x | 0, f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

// Deterministic PRNG, so "Refill" is reproducible from a seed and a shape that
// looked good can be got back.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ObjectCell {
  constructor(maxShards) {
    this.max = maxShards;
    this.count = 0;
    this.sizeScale = 1;
    this.seed = 1;

    const m = maxShards;
    this.px = new Float32Array(m); this.py = new Float32Array(m);
    this.vx = new Float32Array(m); this.vy = new Float32Array(m);
    this.ang = new Float32Array(m); this.spin = new Float32Array(m);
    this.invI = new Float32Array(m);    // 1/angular inertia, weighting every spin input
    this.baseR = new Float32Array(m);   // radius before the size slider
    this.rad = new Float32Array(m);
    this.sides = new Float32Array(m);
    this.phase = new Float32Array(m);
    this.cr = new Float32Array(m); this.cg = new Float32Array(m); this.cb = new Float32Array(m);
    this.opacity = new Float32Array(m); // per-shard multiplier on the density slider
    this.slot = new Float32Array(m);    // palette index, as a 0..1 draw
    // Shape draws, kept as raw 0..1 randoms rather than as resolved geometry:
    // switching shape mode is then a repack, not a respawn, so the pile keeps
    // its positions and the picture morphs instead of jumping.
    this.famR = new Float32Array(m);    // which family, in 'mixed'
    this.auxR = new Float32Array(m);    // star waist / sliver aspect
    this.glyphR = new Float32Array(m);  // which character

    // Instance data. Split by update rate: the transform changes every frame,
    // the appearance only when a control moves, so the static half is uploaded
    // once instead of 300 times a second.
    this.xform = new Float32Array(m * 4);   // x, y, rotation, radius
    this.style = new Float32Array(m * 8);   // rgb, alpha, sides, phase, family, aux
    this.styleDirty = true;

    // Broadphase scratch, sized for the finest grid we will ever build.
    this.gridStart = new Int32Array(1);
    this.gridItems = new Int32Array(m);

    this.accumulator = 0;
    this.stepHz = 180;
    this.paletteIndex = 0;
    this.densityAlpha = 0.55;
    this.tumble = 1;
    this.shapeMode = 'chips';
    this.glyphCount = 1;
    this.setCount(360);
  }

  setCount(n) {
    // Zero is allowed: an empty cell is how you look at a backdrop through the
    // mirrors with no glass in the way.
    n = Math.max(0, Math.min(this.max, n | 0));
    // Each shard gets its own stream, keyed on (seed, index). Sharing one
    // stream would mean the number of draws per shard had to be counted by
    // hand, and every shard already on screen would silently change identity
    // the moment that count drifted from the spawn code.
    for (let i = this.count; i < n; i++) this._spawn(i, mulberry32(this.seed ^ Math.imul(i + 1, 0x9E3779B1)));
    this.count = n;
    this.styleDirty = true;
    this._applySize();
    this._applyPalette();
  }

  refill(seed) {
    this.seed = (seed === undefined ? (Math.random() * 1e9) | 0 : seed) >>> 0;
    const n = this.count;
    this.count = 0;
    this.setCount(n);
    this._applySize();
    this.shake(1.4);
  }

  _spawn(i, rnd) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 0.85;
    this.px[i] = Math.cos(a) * r;
    this.py[i] = Math.sin(a) * r;
    this.vx[i] = (rnd() - 0.5) * 0.5;
    this.vy[i] = (rnd() - 0.5) * 0.5;
    this.ang[i] = rnd() * Math.PI * 2;
    // Drawn here to keep this stream's draw order stable, but scaled below:
    // the weighting depends on the radius, which is not known until the next
    // draw, and reordering the draws would change what a seed produces.
    const spin0 = (rnd() - 0.5) * SPIN_SPAWN;
    // Heavy tail: a real cell is mostly chips with a few big statement pieces.
    const t = rnd();
    this.baseR[i] = 0.018 + Math.pow(t, 2.4) * 0.075;
    this.invI[i] = spinInertia(this.baseR[i]);
    this.spin[i] = spin0 * this.invI[i];
    this.sides[i] = 3 + Math.floor(rnd() * 6);
    this.phase[i] = rnd() * Math.PI * 2;
    this.opacity[i] = 0.55 + rnd() * 0.65;
    this.slot[i] = rnd();          // which palette entry, kept across palettes
    this.famR[i] = rnd();
    this.auxR[i] = rnd();
    this.glyphR[i] = rnd();
  }

  _applyPalette() {
    const p = PALETTES[this.paletteIndex];
    const pal = paletteRgb(p);
    const ramp = p.kind === 'ramp';
    for (let i = 0; i < this.count; i++) {
      const c = ramp ? rampAt(pal, this.slot[i])
        : pal[Math.floor(this.slot[i] * pal.length) % pal.length];
      this.cr[i] = c[0]; this.cg[i] = c[1]; this.cb[i] = c[2];
    }
    this.styleDirty = true;
  }

  setPalette(index) { this.paletteIndex = index % PALETTES.length; this._applyPalette(); }
  setDensity(alpha) { this.densityAlpha = alpha; this.styleDirty = true; }
  setTumble(t) { this.tumble = Math.max(0, t); }
  setShape(mode) { this.shapeMode = mode; this.styleDirty = true; }
  setGlyphCount(n) { this.glyphCount = Math.max(1, n | 0); this.styleDirty = true; }

  setSize(scale) { this.sizeScale = scale; this._applySize(); }

  _applySize() {
    let maxR = 0;
    for (let i = 0; i < this.count; i++) {
      const r = this.baseR[i] * this.sizeScale;
      this.rad[i] = r;
      if (r > maxR) maxR = r;
    }
    this.maxRad = Math.max(maxR, 0.01);
    this.styleDirty = true;
  }

  shake(strength = 1) {
    for (let i = 0; i < this.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = strength * (0.6 + Math.random() * 1.6);
      this.vx[i] += Math.cos(a) * s;
      this.vy[i] += Math.sin(a) * s;
      this.spin[i] += (Math.random() - 0.5) * strength * SPIN_KICK * this.invI[i] * this.tumble;
    }
  }

  // dt is wall-clock; the sim runs on a fixed internal step so behaviour does
  // not drift with frame rate. Returns the number of substeps taken.
  update(dt, opts) {
    const h = 1 / this.stepHz;
    this.accumulator = Math.min(this.accumulator + dt, h * 8);
    let steps = 0;
    while (this.accumulator >= h) {
      this._step(h, opts);
      this.accumulator -= h;
      steps++;
    }
    return steps;
  }

  _step(h, opts) {
    const n = this.count;
    const { gravity, roll, rollRate, agitation } = opts;

    // Gravity is fixed in the world; the cell rotates with the tube, so in cell
    // coordinates "down" swings round as you roll it. That is why the pile
    // slides when you turn a kaleidoscope, and it is the whole feel of the sim.
    const gx = -Math.sin(roll) * gravity;
    const gy = -Math.cos(roll) * gravity;

    const damp = Math.exp(-0.55 * h);
    const spinDamp = Math.exp(-SPIN_DECAY * h);
    const jitter = agitation * 9.0;
    // Read once per substep by _pair and _walls, which is cheaper than handing
    // the same two numbers down through every contact.
    this._spinK = SPIN_COUPLE * this.tumble;
    this._spinCap = MAX_SPIN * this.tumble;

    for (let i = 0; i < n; i++) {
      let vx = this.vx[i] + gx * h;
      let vy = this.vy[i] + gy * h;
      if (jitter > 0) {
        vx += (Math.random() - 0.5) * jitter * h;
        vy += (Math.random() - 0.5) * jitter * h;
      }
      // The chamber wall drags the glass round with the tube.
      if (rollRate !== 0) {
        const tx = -this.py[i] * rollRate, ty = this.px[i] * rollRate;
        const grip = 0.9 * h;
        vx += (tx - vx) * grip;
        vy += (ty - vy) * grip;
      }
      vx *= damp; vy *= damp;
      this.vx[i] = vx; this.vy[i] = vy;
      this.px[i] += vx * h;
      this.py[i] += vy * h;
      this.ang[i] += this.spin[i] * h;
      // Decay, then clip. Clipping here rather than after the contact passes
      // costs nothing extra and is a substep behind, which is invisible.
      let sp = this.spin[i] * spinDamp;
      const cap = this._spinCap * this.invI[i];
      this.spin[i] = sp > cap ? cap : (sp < -cap ? -cap : sp);
    }

    this._collide();
    this._walls();
  }

  // Uniform-grid broadphase built by counting sort: two linear passes, no
  // per-cell arrays, nothing allocated after the first call at a given size.
  _collide() {
    const n = this.count;
    const cs = this.maxRad * 2.0;
    const dim = Math.max(1, Math.min(96, Math.ceil((CELL_R * 2.2) / cs)));
    const cells = dim * dim;
    if (this.gridStart.length < cells + 1) this.gridStart = new Int32Array(cells + 1);
    const start = this.gridStart, items = this.gridItems;
    start.fill(0, 0, cells + 1);

    const toCell = (v) => {
      const k = Math.floor((v + CELL_R * 1.1) / (CELL_R * 2.2) * dim);
      return k < 0 ? 0 : (k >= dim ? dim - 1 : k);
    };

    for (let i = 0; i < n; i++) {
      const c = toCell(this.py[i]) * dim + toCell(this.px[i]);
      start[c + 1]++;
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const cursor = this._cursor && this._cursor.length >= cells
      ? this._cursor : (this._cursor = new Int32Array(cells));
    cursor.set(start.subarray(0, cells));
    for (let i = 0; i < n; i++) {
      const c = toCell(this.py[i]) * dim + toCell(this.px[i]);
      items[cursor[c]++] = i;
    }

    for (let gy = 0; gy < dim; gy++) {
      for (let gx = 0; gx < dim; gx++) {
        const c = gy * dim + gx;
        for (let ai = start[c]; ai < start[c + 1]; ai++) {
          const i = items[ai];
          // Only the half-neighbourhood, so each pair is visited once.
          for (let ny = gy; ny <= gy + 1 && ny < dim; ny++) {
            for (let nx = gx - 1; nx <= gx + 1; nx++) {
              if (nx < 0 || nx >= dim) continue;
              if (ny === gy && nx < gx) continue;
              const c2 = ny * dim + nx;
              let bi = start[c2];
              if (c2 === c) bi = ai + 1;
              for (; bi < start[c2 + 1]; bi++) {
                this._pair(i, items[bi]);
              }
            }
          }
        }
      }
    }
  }

  _pair(i, j) {
    let dx = this.px[j] - this.px[i];
    let dy = this.py[j] - this.py[i];
    const rr = this.rad[i] + this.rad[j];
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 === 0) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    const overlap = rr - d;

    // Mass from area: the big statement pieces shoulder the chips aside.
    const mi = this.rad[i] * this.rad[i], mj = this.rad[j] * this.rad[j];
    const inv = 1 / (mi + mj);
    const wi = mj * inv, wj = mi * inv;

    this.px[i] -= nx * overlap * wi; this.py[i] -= ny * overlap * wi;
    this.px[j] += nx * overlap * wj; this.py[j] += ny * overlap * wj;

    const rvx = this.vx[j] - this.vx[i], rvy = this.vy[j] - this.vy[i];
    const vn = rvx * nx + rvy * ny;
    if (vn > 0) return;
    const imp = -(1 + MAX_RESTITUTION) * vn;
    this.vx[i] -= nx * imp * wi; this.vy[i] -= ny * imp * wi;
    this.vx[j] += nx * imp * wj; this.vy[j] += ny * imp * wj;

    // Grazing contacts set the pieces turning.
    const tang = (-rvx * ny + rvy * nx) * this._spinK;
    this.spin[i] -= tang * this.invI[i];
    this.spin[j] += tang * this.invI[j];
  }

  _walls() {
    for (let i = 0; i < this.count; i++) {
      const x = this.px[i], y = this.py[i];
      const lim = CELL_R - this.rad[i];
      const d2 = x * x + y * y;
      if (d2 <= lim * lim) continue;
      const d = Math.sqrt(d2) || 1e-6;
      const nx = x / d, ny = y / d;
      this.px[i] = nx * lim; this.py[i] = ny * lim;
      const vn = this.vx[i] * nx + this.vy[i] * ny;
      if (vn > 0) {
        this.vx[i] -= (1 + MAX_RESTITUTION) * vn * nx;
        this.vy[i] -= (1 + MAX_RESTITUTION) * vn * ny;
      }
      // Friction against the chamber wall, and the spin it imparts.
      const tx = -ny, ty = nx;
      const vt = this.vx[i] * tx + this.vy[i] * ty;
      this.vx[i] -= vt * 0.25 * tx; this.vy[i] -= vt * 0.25 * ty;
      this.spin[i] += vt * this._spinK * this.invI[i];
    }
  }

  // Pack the per-frame half of the instance data. Written in place; the caller
  // uploads xform every frame and style only when styleDirty.
  packTransforms() {
    const x = this.xform;
    for (let i = 0, o = 0; i < this.count; i++, o += 4) {
      x[o] = this.px[i]; x[o + 1] = this.py[i];
      x[o + 2] = this.ang[i]; x[o + 3] = this.rad[i];
    }
    return this.count * 4;
  }

  // Resolve each shard's shape for the current mode. The families are the ones
  // SHARD_VS knows about: 0 polygon, 1 star, 2 sliver, 3 glyph — with the
  // fourth component meaning the star's waist, the sliver's aspect, or the
  // glyph's index into the atlas, depending on which.
  packStyle() {
    const s = this.style;
    const mode = this.shapeMode;
    const gN = this.glyphCount;
    for (let i = 0, o = 0; i < this.count; i++, o += 8) {
      s[o] = this.cr[i]; s[o + 1] = this.cg[i]; s[o + 2] = this.cb[i];
      s[o + 3] = Math.min(1, this.densityAlpha * this.opacity[i]);

      let fam = 0, sides = this.sides[i], aux = 0;
      if (mode === 'glyphs') {
        fam = 3;
        aux = Math.floor(this.glyphR[i] * gN) % gN;
      } else if (mode === 'stars') {
        fam = 1; sides = 5 + Math.floor(this.famR[i] * 4); aux = 0.34 + this.auxR[i] * 0.26;
      } else if (mode === 'slivers') {
        fam = 2; aux = 0.09 + this.auxR[i] * 0.28;
      } else if (mode === 'mixed') {
        const k = this.famR[i];
        if (k > 0.78) { fam = 2; aux = 0.09 + this.auxR[i] * 0.28; }
        else if (k > 0.48) { fam = 1; sides = 5 + Math.floor(this.auxR[i] * 4); aux = 0.34 + this.auxR[i] * 0.26; }
      }
      s[o + 4] = sides; s[o + 5] = this.phase[i]; s[o + 6] = fam; s[o + 7] = aux;
    }
    this.styleDirty = false;
    return this.count * 8;
  }
}
