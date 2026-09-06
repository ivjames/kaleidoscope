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
 * to bottom. Returns the canvas plus the grid dimensions the shader needs.
 */
export function buildAtlas(chars, cellPx = 128) {
  const list = chars.slice(0, MAX_GLYPHS);
  const count = Math.max(1, list.length);
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const w = cols * cellPx, h = rows * cellPx;

  if (!sheet) sheet = document.createElement('canvas');
  sheet.width = w; sheet.height = h;
  const ctx = sheet.getContext('2d', { willReadFrequently: false });
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

  for (let i = 0; i < list.length; i++) {
    const cx = (i % cols) * cellPx + cellPx / 2;
    const cy = Math.floor(i / cols) * cellPx + cellPx / 2;
    const m = ctx.measureText(list[i]);
    // Wide glyphs (emoji sequences, some symbols) and tall ones both need to be
    // brought back inside the box; ascent/descent give the real ink height,
    // which is much tighter than the em box for digits and punctuation.
    const gw = Math.max(1, m.actualBoundingBoxLeft + m.actualBoundingBoxRight || m.width);
    const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
    const gh = Math.max(1, (isFinite(asc) && isFinite(desc)) ? asc + desc : base);
    const k = Math.min(1, box / gw, box / gh);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(k, k);
    ctx.fillText(list[i], 0, 0);
    ctx.restore();
  }

  return { canvas: sheet, cols, rows, count: list.length || 1, chars: list };
}
