// The object cell — the disc-shaped chamber of loose coloured glass at the far
// end of the tube. Everything a kaleidoscope actually *does* happens because
// this stuff moves: rolling the tube slides the pile, and the mirrors turn
// whatever it settles into a pattern.
//
// It is a 2D rigid-body sim with a counting-sort broadphase, run on a fixed
// timestep so the picture behaves the same at 60 fps and at 300. Contacts are
// taken against each shard's real outline rather than a bounding circle (see
// _support), which is why a sliver settles lying against its neighbour instead
// of balancing on a point, and why every bit of rotation in the cell is
// something a contact did. All state is in flat typed arrays and the per-frame
// instance upload writes straight into a pre-allocated Float32Array, so a step
// allocates nothing.

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
const TAU = Math.PI * 2;

// --- how much glass fits in the chamber -------------------------------------
//
// The cell is a disc of fixed size, so there is a real limit on how many shards
// can be in it before the solver is being asked to unpick a pile that has no
// solution: at that point contacts never resolve, shards sit inside one another
// and the whole cell twitches. The slider used to run to 2400 regardless of
// shard size, which at the default size is roughly sixteen times over.
//
// FILL_LIMIT is the fraction of the chamber's area the glass may cover. 0.85 is
// deliberately past random loose packing (~0.55) and near the dense limit — a
// jar of glass IS packed. It is measured at the knee: at the default shard size
// the pile settles to a median overlap of about 2% at this fill and degrades
// sharply above it.
export const FILL_LIMIT = 0.85;
// E[baseR^2] for the spawn distribution below: baseR = 0.018 + t^2.4 * 0.075,
// t uniform. Integrated once here rather than sampled, so the cap is stable.
const MEAN_R2 = 0.002088;

// The largest shard count that still fits at a given size, which is what the
// Shards slider's maximum tracks. Raising Shard size therefore lowers the
// ceiling instead of overfilling the chamber.
//
// The caller's hardMax is the other half of the limit and is not redundant with
// this one. Area fill only binds at large shard sizes: gravity drags the whole
// cell into a heap at the bottom whatever the fill fraction is, so a thousand
// tiny chips make a pile a great many layers deep, and relaxation unpicks one
// layer per pass. Below a certain size the binding constraint stops being "does
// it fit" and becomes "can the solver still resolve it", which is a count, not
// an area.
export function maxCountForSize(sizeScale, hardMax) {
  const n = Math.floor(FILL_LIMIT / (MEAN_R2 * sizeScale * sizeScale));
  return Math.max(8, Math.min(hardMax, n));
}

// Contacts are solved by relaxation, and one pass is not enough: a pass only
// propagates a correction one contact deep, so a pile several shards tall needs
// several. Three settles the default cell to a median overlap of a percent or
// two. Past that the returns are poor and the cost is linear — on a 300-shard
// pile, going from three passes to eight roughly halves the deepest overlaps
// for about two and a half times the time — so a big cell trades the third
// pass for the frame time instead.
function solverIters(n) { return n > 180 ? 2 : 3; }

// Agitation is a random walk on velocity, so the per-substep kick has to scale
// with sqrt(h) for the result to be the same at any step rate. The old code
// scaled it with h, which made the slider's whole range add up to less than a
// tenth of gravity — it genuinely did almost nothing.
const AGITATION = 26.0;

// --- how the glass turns -----------------------------------------------------
//
// Every source of spin here is a contact. Nothing hands a shard rotation from
// outside: a piece of glass is not born spinning, and a shake is a push rather
// than a twist — shaking a real tube throws the pile about, it does not reach
// in and turn each chip. The pieces are loose in a chamber, so the only things
// that can turn one are the neighbour it grazes and the wall it scrapes along.
// Rotation is therefore emergent, and if the cell looks too still or too busy,
// the fix belongs in the contact model rather than in a spin term.
//
// That is also what makes it self-limiting in a way an injected spin was not:
// contacts both add spin and take it away, because a piece turning against its
// neighbours is doing work on them.
//
// The two contact sources, both in _pair and _walls:
//   SPIN_COUPLE   tangential slip — a graze, or a scrape along the chamber wall
//   SHAPE_TORQUE  a push landing off the shard's own centre line, which is what
//                 makes a sliver rotate until it lies flat against a neighbour
//                 instead of balancing on a corner
const SPIN_COUPLE = 0.13;    // spin picked up per unit of tangential slip
const SPIN_DECAY = 2.6;      // e-folds per second once nothing is touching it
const SHAPE_TORQUE = 0.9;    // spin picked up per unit of off-centre push
// Not a feature — a numerical guard. Two shards resolving a deep overlap can
// produce one large impulse, and with no ceiling a single bad substep would
// leave one chip spinning visibly faster than everything around it.
const MAX_SPIN = 3.5;        // rad/s, before the size weighting

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
    // …and the geometry those draws resolve to under the current shape mode.
    // Resolved once per mode change rather than per frame, because the contact
    // solver reads them at 180 Hz as well as the instance packer.
    this.fam = new Float32Array(m);     // 0 polygon, 1 star, 2 sliver, 3 glyph
    // The two shape parameters the shader's aShape.xy carries, and what they
    // mean depends on the family — polygon and star want a corner count and a
    // phase, sliver and glyph want the two half-extents of a rectangle. Held
    // under neutral names because the instance buffer has exactly these two
    // slots and both families have to fit through them.
    this.pA = new Float32Array(m);
    this.pB = new Float32Array(m);
    this.aux = new Float32Array(m);     // star waist / glyph index
    this.areaK = new Float32Array(m);   // outline area / radius², i.e. how solid it is
    // Trig the contact solver would otherwise redo per contact. cosA/sinA are
    // refreshed once per substep when the angle is integrated; the sector
    // constants only when the shape mode changes.
    this.cosA = new Float32Array(m); this.sinA = new Float32Array(m);
    this.beta = new Float32Array(m);    // angle between adjacent corners
    this.invBeta = new Float32Array(m);
    this.sinB = new Float32Array(m); this.cosB = new Float32Array(m);

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
    // Declared here rather than sprouted on the first update: _step rewrites
    // them every substep and _pair/_walls read them, and this file's whole
    // contract is that a step surprises the engine with nothing.
    this._spinK = 0;
    this._spinCap = 0;
    this._dim = 1;        // broadphase grid pitch, set by _grid, read by _solve
    this._supTan = 0;     // _support's side channel: (1/r)·dr/dθ at the last query
    this.paletteIndex = 0;
    this.densityAlpha = 0.55;
    this.tumble = 1;
    this.shapeMode = 'chips';
    this.glyphCount = 1;
    this.glyphExt = null;   // per-glyph ink half-extents, from buildAtlas
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
    this._resolveShapes();
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
    // Heavy tail: a real cell is mostly chips with a few big statement pieces.
    const t = rnd();
    this.baseR[i] = 0.018 + Math.pow(t, 2.4) * 0.075;
    this.invI[i] = spinInertia(this.baseR[i]);
    // A shard is born at rest. It gets a random *angle* — a piece of glass
    // tipped into a chamber lands whichever way up it lands — but not a random
    // spin, because nothing spun it.
    this.spin[i] = 0;
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
  setShape(mode) { this.shapeMode = mode; this._resolveShapes(); }
  // The atlas hands over how much of each cell its glyph's ink actually covers.
  // Without it a glyph collides as its whole cell, which for an emoji is about
  // twice the area of anything visible and for a "1" is ten times — the cell
  // full of characters held itself apart with oceans of empty space.
  setGlyphs(n, ext) {
    this.glyphCount = Math.max(1, n | 0);
    this.glyphExt = ext || null;
    this._resolveShapes();
  }

  // Resolve each shard's shape for the current mode. The families are the ones
  // SHARD_VS knows about: 0 polygon, 1 star, 2 sliver, 3 glyph — with aux
  // meaning the star's waist, the sliver's aspect, or the glyph's index into
  // the atlas, depending on which. Kept as state rather than recomputed in
  // packStyle so that _support can read the same numbers the shader draws.
  _resolveShapes() {
    const mode = this.shapeMode;
    const gN = this.glyphCount;
    for (let i = 0; i < this.count; i++) {
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
      // The rectangle families carry half-extents instead of a corner count and
      // a phase: 1.0 spans the square inscribed in the shard's disc. A sliver
      // is that square squashed on its local y; a glyph is its own ink box.
      let pA = sides, pB = this.phase[i];
      if (fam > 1.5) {
        pA = 1; pB = aux;
        if (fam > 2.5) {
          const e = this.glyphExt;
          const o = aux * 2;
          pA = e && o + 1 < e.length ? e[o] : 1;
          pB = e && o + 1 < e.length ? e[o + 1] : 1;
        }
      }
      this.fam[i] = fam; this.pA[i] = pA; this.pB[i] = pB; this.aux[i] = aux;
      const beta = TAU / (fam < 0.5 ? sides : (fam < 1.5 ? sides * 2 : 4));
      this.beta[i] = beta; this.invBeta[i] = 1 / beta;
      this.sinB[i] = Math.sin(beta); this.cosB[i] = Math.cos(beta);
      this.cosA[i] = Math.cos(this.ang[i]); this.sinA[i] = Math.sin(this.ang[i]);
      // How much glass is actually inside the outline, per unit of radius².
      // A contact weights the two shards by this, so a needle no longer
      // shoulders a chip aside on the strength of a bounding circle it barely
      // fills. Exact areas for the shapes SHARD_VS draws: a regular n-gon, a
      // star as 2n triangles between its outer and inner corners, and the
      // inscribed square, squashed on one axis for a sliver.
      this.areaK[i] = fam < 0.5 ? 0.5 * sides * Math.sin(TAU / sides)
        : (fam < 1.5 ? sides * aux * Math.sin(Math.PI / sides)
          : 2 * pA * pB);
    }
    this.styleDirty = true;
  }

  // How far shard i's outline reaches along the unit direction (dx, dy) — its
  // support radius. This is the whole of "collide with the shape rather than
  // with a bounding circle": the contact test becomes
  // d < support(i, n) + support(j, -n) instead of d < rad[i] + rad[j], and
  // because it depends on the shard's own angle, a sliver end-on is now a
  // needle and side-on is a plank.
  //
  // Full convex-polygon contact (SAT, clipped manifolds, two-point contacts)
  // would be a different and much heavier sim. This is the cheap middle: exact
  // for every one of the four families along the contact normal, and paid for
  // only by the pairs the bounding circles already accepted.
  //
  // It takes a vector rather than an angle so the direction can be rotated into
  // the shard's own frame with the cosA/sinA cached at integration time. That
  // makes a sliver or a glyph contact trig-free, and leaves the polygons one
  // atan2 and one sin/cos rather than four transcendentals.
  //
  // It also leaves _supTan = (1/r)·dr/dθ, the tangent of the angle between the
  // outline's normal there and the radial direction. That is what tells the
  // solver a push landed off the shard's centre line, i.e. how much it turns it.
  _support(i, dx, dy) {
    const R = this.rad[i];
    const ca0 = this.cosA[i], sa0 = this.sinA[i];
    const lx = dx * ca0 + dy * sa0;      // the direction, in the shard's frame
    const ly = dy * ca0 - dx * sa0;
    const fam = this.fam[i];
    if (fam >= 2) {
      // Sliver and glyph are both the square inscribed in the shard's disc, the
      // sliver squashed on its local y — a rectangle, so the support is
      // whichever face the ray leaves through. Its normal is a local axis, and
      // tan is pi-periodic, so which of the two faces on that axis it is makes
      // no difference to the tilt.
      const hx = R * 0.70710678 * this.pA[i];
      const hy = R * 0.70710678 * this.pB[i];
      const ax = lx < 0 ? -lx : lx, ay = ly < 0 ? -ly : ly;
      if (hx * ay <= hy * ax) { this._supTan = ly / lx; return hx / ax; }
      this._supTan = -lx / ly;
      return hy / ay;
    }
    // Polygon and star are the same walk: n corners for the polygon, 2n for the
    // star with every other one pulled in to aux — exactly as SHARD_VS draws
    // them. Between two adjacent corners the outline is a chord, and the
    // support along a chord between polar points (r1, 0) and (r2, beta) is
    // r1·r2·sin beta / (r1·sin a + r2·sin(beta − a)).
    const beta = this.beta[i];
    const t = (Math.atan2(ly, lx) - this.pB[i]) * this.invBeta[i];
    const k = Math.floor(t);
    const a = (t - k) * beta;
    let r1 = R, r2 = R;
    if (fam >= 0.5) {
      const w = R * this.aux[i];
      if ((k & 1) === 0) r2 = w; else r1 = w;
    }
    const sa = Math.sin(a), ca = Math.cos(a);
    const sB = this.sinB[i], cB = this.cosB[i];
    const sb = sB * ca - cB * sa;        // sin(beta − a), without a second sin
    const cb = cB * ca + sB * sa;        // cos(beta − a)
    const K = r1 * r2 * sB;
    const den = r1 * sa + r2 * sb;
    const r = den > 1e-9 ? K / den : R;
    // d/da of the above, divided by r: the chord's tilt away from radial, zero
    // at the middle of a face and largest at a corner.
    this._supTan = -r * (r1 * ca - r2 * cb) / K;
    return r;
  }

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

  // Shaking the tube throws the pile about; it does not twist each piece. The
  // tumbling that follows a shake is the pieces colliding on the way down,
  // which the contact model produces on its own.
  shake(strength = 1) {
    for (let i = 0; i < this.count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = strength * (0.6 + Math.random() * 1.6);
      this.vx[i] += Math.cos(a) * s;
      this.vy[i] += Math.sin(a) * s;
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
    // sqrt(h), not h: this is a random walk, so its per-second amplitude only
    // stays put across step rates if each kick scales with the square root of
    // the step. Scaled with h it summed to nothing next to gravity.
    const jitter = agitation * AGITATION * Math.sqrt(h);
    // Read once per substep by _pair and _walls, which is cheaper than handing
    // the same two numbers down through every contact.
    this._spinK = SPIN_COUPLE * this.tumble;
    this._spinCap = MAX_SPIN * this.tumble;

    for (let i = 0; i < n; i++) {
      let vx = this.vx[i] + gx * h;
      let vy = this.vy[i] + gy * h;
      if (jitter > 0) {
        vx += (Math.random() - 0.5) * jitter;
        vy += (Math.random() - 0.5) * jitter;
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
      const ang = this.ang[i] + this.spin[i] * h;
      this.ang[i] = ang;
      // One sin/cos per shard per substep, so a contact needs none.
      this.cosA[i] = Math.cos(ang); this.sinA[i] = Math.sin(ang);
      // Decay, then clip. Clipping here rather than after the contact passes
      // costs nothing extra and is a substep behind, which is invisible.
      let sp = this.spin[i] * spinDamp;
      const cap = this._spinCap * this.invI[i];
      this.spin[i] = sp > cap ? cap : (sp < -cap ? -cap : sp);
    }

    // Relaxation: one broadphase, then a few contact passes. Velocity impulses
    // are applied on the first pass only — the later ones are positional, so a
    // dense pile is unpicked without being damped into treacle.
    this._grid();
    const iters = solverIters(n);
    for (let it = 0; it < iters; it++) {
      this._solve(it === 0);
      this._walls(it === 0);
    }
  }

  // Uniform-grid broadphase built by counting sort: two linear passes, no
  // per-cell arrays, nothing allocated after the first call at a given size.
  // Built once per substep and walked once per relaxation pass — shards barely
  // move between passes, so rebuilding it each time buys nothing.
  _grid() {
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
    this._dim = dim;
  }

  _solve(velocity) {
    const dim = this._dim;
    const start = this.gridStart, items = this.gridItems;
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
                this._pair(i, items[bi], velocity);
              }
            }
          }
        }
      }
    }
  }

  _pair(i, j, velocity) {
    const dx = this.px[j] - this.px[i];
    const dy = this.py[j] - this.py[i];
    // Bounding circles first: this rejects almost every candidate the grid
    // hands over, and only the survivors pay for the outlines.
    const rr = this.rad[i] + this.rad[j];
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 === 0) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;

    // …then the shapes themselves, along the line of centres.
    const ri = this._support(i, nx, ny);
    const ti = this._supTan;
    const rj = this._support(j, -nx, -ny);
    const tj = this._supTan;
    const contact = ri + rj;
    if (d >= contact) return;
    // Capped: a shard turning into a neighbour can gain depth in one substep,
    // and an uncapped correction would fling the pair apart.
    let overlap = contact - d;
    if (overlap > rr * 0.5) overlap = rr * 0.5;

    // Mass from the glass actually in the outline, so a big statement piece
    // shoulders the chips aside but a sliver of the same reach does not.
    const mi = this.areaK[i] * this.rad[i] * this.rad[i];
    const mj = this.areaK[j] * this.rad[j] * this.rad[j];
    const inv = 1 / (mi + mj);
    const wi = mj * inv, wj = mi * inv;

    this.px[i] -= nx * overlap * wi; this.py[i] -= ny * overlap * wi;
    this.px[j] += nx * overlap * wj; this.py[j] += ny * overlap * wj;

    if (!velocity) return;

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

    // …and so does a push that lands off the centre line. _supTan is
    // tan of the angle between the shard's surface normal there and the
    // radial direction, so the torque about its centre is r·F·sin(that) —
    // which is what makes a sliver rotate until it lies against its neighbour
    // instead of balancing on a corner.
    const k = SHAPE_TORQUE * imp * this.tumble;
    this.spin[i] += k * ri * (ti / Math.sqrt(1 + ti * ti)) * this.invI[i];
    this.spin[j] += k * rj * (tj / Math.sqrt(1 + tj * tj)) * this.invI[j];
  }

  _walls(velocity) {
    for (let i = 0; i < this.count; i++) {
      const x = this.px[i], y = this.py[i];
      const bound = CELL_R - this.rad[i];
      const d2 = x * x + y * y;
      if (d2 <= bound * bound) continue;      // bounding circle, as above
      const d = Math.sqrt(d2) || 1e-6;
      const nx = x / d, ny = y / d;
      // The chamber wall meets the shard's outline, not its bounding circle —
      // so a sliver lying flat against the wall reaches it, and end-on it
      // stands further out.
      const lim = CELL_R - this._support(i, nx, ny);
      if (d <= lim) continue;
      this.px[i] = nx * lim; this.py[i] = ny * lim;
      if (!velocity) continue;
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

  // Pack the appearance half of the instance data. The geometry it hands the
  // shader is exactly what _resolveShapes worked out and _support collides
  // with, so the picture and the physics can never disagree about what a
  // shard's outline is.
  packStyle() {
    const s = this.style;
    for (let i = 0, o = 0; i < this.count; i++, o += 8) {
      s[o] = this.cr[i]; s[o + 1] = this.cg[i]; s[o + 2] = this.cb[i];
      s[o + 3] = Math.min(1, this.densityAlpha * this.opacity[i]);
      s[o + 4] = this.pA[i]; s[o + 5] = this.pB[i];
      s[o + 6] = this.fam[i]; s[o + 7] = this.aux[i];
    }
    this.styleDirty = false;
    return this.count * 8;
  }
}
