// The glyph atlas — how letters, numbers and emoji get into the object cell.
//
// A shard is one instance of a 26-vertex fan, so there is no room for per-shard
// geometry and no question of triangulating a font. Instead every character in
// the set is rasterised once, by canvas2D, into one square texture; a shard in
// glyph mode is a quad that samples its own cell of that texture. The cost is
// one texture fetch in the shard pass and nothing at all per frame — the atlas
// is rebuilt only when the character set changes.
//
// Emoji come out of canvas already coloured (they are colour-font bitmaps),
// while ordinary text is painted white so the palette tint can multiply
// through it. One shader path covers both: see uNative in SHARD_FS.

// Cap the set at one 8x8 sheet. Beyond a few dozen distinct glyphs the cell
// reads as noise anyway, and the atlas stays a single 1024-square texture.
export const MAX_GLYPHS = 64;

export const GLYPH_PRESETS = [
  { name: 'Sparks & stars',  text: '✦✧★☆✺✹❉❋✷✵❈✶' },
  { name: 'Letters A–Z',     text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { name: 'Lowercase a–z',   text: 'abcdefghijklmnopqrstuvwxyz' },
  { name: 'Numbers 0–9',     text: '0123456789' },
  { name: 'Digits & signs',  text: '0123456789+−×÷=%π∞√∫≈≠' },
  { name: 'Gems & glass',    text: '💎🔮✨🪩🫧🧊💠🔷🔶⭐️🌟💫' },
  { name: 'Garden',          text: '🌸🌺🌼🌻🌷🍀🌿🍃🌱🪻🪷🌹' },
  { name: 'Fruit',           text: '🍎🍊🍋🍉🍇🍓🫐🥝🍑🍍🥭🍒' },
  { name: 'Faces',           text: '😀😍🤩😎🥳😜🤪😱🥶🤯😈👽' },
  { name: 'Weather',         text: '☀️🌙⭐️☁️🌈⚡️❄️🔥💧🌊🌪️☄️' },
  { name: 'Suits & pips',    text: '♠︎♥︎♦︎♣︎♤♡♢♧⚀⚁⚂⚃⚄⚅' },
  { name: 'Arrows',          text: '←↑→↓↖↗↘↙⇄⇅↺↻' },
  { name: 'Music',           text: '♩♪♫♬♭♮♯𝄞🎵🎶' },
];

// Splitting on code points is wrong for anything with a skin tone, a variation
// selector or a ZWJ in it: 👩‍🚀 is five code points and one glyph. Segmenter
// gets that right; the fallback (Array.from, i.e. code points) at least keeps
// surrogate pairs together, which is the common case.
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

export function splitGraphemes(text) {
  const src = String(text || '');
  const out = [];
  if (segmenter) {
    for (const s of segmenter.segment(src)) {
      const g = s.segment;
      if (g.trim()) out.push(g);
    }
  } else {
    for (const g of Array.from(src)) if (g.trim()) out.push(g);
  }
  return out;
}

const FONT_STACK = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",` +
  `"Segoe UI Symbol","Noto Sans Symbols 2",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`;

// One canvas, reused. Rebuilding the atlas on every keystroke of the text box
// would otherwise leak a megabyte of backing store per character typed.
let sheet = null;

/**
 * Rasterise `chars` into a square sheet of equal cells, left to right and top
 * to bottom. Returns the canvas, the grid dimensions the shader needs, and —
 * per glyph — how much of its cell the ink actually covers.
 *
 * That last part is not decoration. A shard in glyph mode is a quad, and if the
 * quad is the whole cell then the shard collides as the whole cell: an emoji
 * fills about 45% of its cell's area, a capital letter 19%, a "1" 9% and a full
 * stop 1%, so the cell was held apart from its neighbours by a box several
 * times the size of anything visible. Reporting the ink box lets the quad — and
 * therefore the contact rectangle — be the glyph rather than the cell.
 *
 * The extents are measured off the rasterised pixels rather than off
 * measureText, because the metrics for a colour emoji are unreliable in a way
 * the pixels never are, and they are taken symmetrically about the cell centre
 * so a quad centred on the shard is guaranteed to contain all of the ink.
 */
export function buildAtlas(chars, cellPx = 128) {
  const list = chars.slice(0, MAX_GLYPHS);
  const count = Math.max(1, list.length);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = cols * cellPx, h = rows * cellPx;

  if (!sheet) sheet = document.createElement('canvas');
  sheet.width = w; sheet.height = h;
  // The sheet is read back once per rebuild to measure the ink, and a rebuild
  // only happens when the character set changes.
  const ctx = sheet.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';

  // Leave a margin inside each cell. Bilinear filtering and the atlas mipmaps
  // both reach past a cell's own texels, so a glyph drawn to the edge would
  // bleed into its neighbour once the shards are small on screen.
  const box = cellPx * 0.78;
  const base = Math.round(cellPx * 0.68);
  ctx.font = `${base}px ${FONT_STACK}`;

  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

  for (let i = 0; i < list.length; i++) {
    const cx = (i % cols) * cellPx + cellPx / 2;
    const cy = Math.floor(i / cols) * cellPx + cellPx / 2;
    const m = ctx.measureText(list[i]);
    // Wide glyphs (emoji sequences, some symbols) and tall ones both need to be
    // brought back inside the box; ascent/descent give the real ink height,
    // which is much tighter than the em box for digits and punctuation.
    const left = num(m.actualBoundingBoxLeft), right = num(m.actualBoundingBoxRight);
    const asc = num(m.actualBoundingBoxAscent), desc = num(m.actualBoundingBoxDescent);
    let gw = left + right; if (!(gw > 0)) gw = m.width || base;
    let gh = asc + desc;   if (!(gh > 0)) gh = base;
    const k = Math.min(1, box / gw, box / gh);
    // Centre the ink, not the text origin. With textBaseline "middle" a glyph
    // with a descender or a tall cap sits off centre in its cell, which both
    // wastes the ink box and makes the shard rotate about a point that is not
    // the middle of what you can see.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.fillText(list[i], -(right - left) / 2, -(desc - asc) / 2);
    ctx.restore();
  }

  return { canvas: sheet, cols, rows, count: list.length || 1, chars: list,
           ext: measureInk(ctx, list.length, cols, cellPx) };
}

// Half-extents of each cell's ink, about the cell's centre, as a fraction of
// the cell (1.0 = the full cell). Symmetric on purpose: the shard's quad is
// centred on the shard, so what it needs is the furthest the ink reaches from
// the middle, not the ink's own asymmetric box.
const INK_ALPHA = 8;        // an alpha this low is antialiasing fringe, not ink
const INK_PAD = 0.03;       // a little room for the bilinear filter to reach into
const INK_MIN = 0.06;       // a full stop is small, but it is not a point

function measureInk(ctx, n, cols, cellPx) {
  const ext = new Float32Array(Math.max(1, n) * 2);
  ext.fill(1);
  const mid = (cellPx - 1) / 2;
  for (let i = 0; i < n; i++) {
    const ox = (i % cols) * cellPx, oy = Math.floor(i / cols) * cellPx;
    let px = 0, py = 0, found = false;
    let d;
    try {
      d = ctx.getImageData(ox, oy, cellPx, cellPx).data;
    } catch (_) {
      continue;             // tainted canvas: leave this glyph at the full cell
    }
    for (let p = 0, q = 3; p < cellPx * cellPx; p++, q += 4) {
      if (d[q] <= INK_ALPHA) continue;
      found = true;
      const dx = Math.abs((p % cellPx) - mid), dy = Math.abs(((p / cellPx) | 0) - mid);
      if (dx > px) px = dx;
      if (dy > py) py = dy;
    }
    // No ink found at all is not a very small glyph, it is a readback that told
    // us nothing — a canvas that came back blank without throwing. Fall back to
    // the whole cell, as the tainted case above does: too generous a contact
    // box is the old behaviour, while too small a one would leave every
    // character colliding as a point while still drawing at full size.
    if (!found) continue;
    // px is a half-extent in pixels; the cell's own half-extent is cellPx/2, so
    // the fraction of the cell the quad must span is 2*px/cellPx.
    ext[i * 2] = Math.min(1, Math.max(INK_MIN, (2 * px + 1) / cellPx + INK_PAD));
    ext[i * 2 + 1] = Math.min(1, Math.max(INK_MIN, (2 * py + 1) / cellPx + INK_PAD));
  }
  return ext;
}
