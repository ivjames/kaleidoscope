// GLSL ES 3.00 sources for the two render passes.
//
// Pass 1 draws the OBJECT CELL — the shallow disc chamber of tumbling glass at
// the far end of a real kaleidoscope — into an offscreen texture. Pass 2 is the
// MIRROR TUBE: it folds view-space coordinates into the tube's fundamental
// domain and samples that texture, which is what a kaleidoscope physically is.
//
// Nothing here allocates or branches per shard: the cell is one instanced draw,
// the tube is one full-screen triangle. That is the whole reason the thing can
// hold triple-digit frame rates with a couple of thousand shards in the cell.

export const FULLSCREEN_VS = `#version 300 es
// One oversized triangle, no vertex buffer: cheaper than a quad (no diagonal
// seam, one less vertex, and the rasteriser sees a single primitive).
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Cell pass: backlight
// ---------------------------------------------------------------------------
// A kaleidoscope's object cell is lit from behind through a frosted plate, so
// the ground truth under the glass is a soft radial falloff, not flat white.
//
// uMediaMix swaps that plate for a picture — camera, screen share, a file. The
// falloff stays as a multiplier even then, because the tube is dark at the rim
// whatever is behind the glass, and because a picture carried flat to the edge
// makes the fold look like wallpaper rather than like something lit.
export const BACKLIGHT_FS = `#version 300 es
precision highp float;
uniform vec2  uRes;
uniform vec3  uWarm;
uniform vec3  uCool;
uniform sampler2D uMedia;
uniform float uMediaMix;
uniform vec2  uMediaScale;
uniform float uMediaGain;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  float r = length(uv);
  float lit = smoothstep(1.35, 0.05, r);
  vec3 col = mix(uCool, uWarm, lit);
  if (uMediaMix > 0.0) {
    vec2 m = uv * uMediaScale * 0.5 + 0.5;
    m.y = 1.0 - m.y;                       // the cell FBO is y-up, video is not
    vec3 pic = texture(uMedia, m).rgb * uMediaGain;
    col = mix(col, pic * mix(0.30, 1.0, lit), uMediaMix);
  }
  outColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// Cell pass: shards
// ---------------------------------------------------------------------------
// One instanced draw for every shard, whatever shape it is. The static vertex
// buffer is a 27-vertex triangle fan (centre + 26 rim points, the last closing
// the loop); aCorner indexes it and the vertex shader decides where each rim
// point actually goes:
//
//   family 0  polygon — quantise the fan angle to an n-gon, 3..12 sides
//   family 1  star    — same, with 2n corners alternating outer/inner radius
//   family 2  sliver  — a quad squashed on one axis, i.e. a needle of glass
//   family 3  glyph   — a square quad carrying atlas UVs: a letter or an emoji
//
// Shapes with fewer corners than the fan has rim points emit repeated vertices,
// i.e. degenerate triangles the rasteriser discards — so every shape in the
// cell comes out of one buffer with no per-shape draw calls.
export const SHARD_VS = `#version 300 es
precision highp float;
layout(location = 0) in float aCorner;   // 0 = centre, 1..26 = rim
layout(location = 1) in vec4  aXform;    // x, y, rotation, radius
layout(location = 2) in vec4  aTint;     // rgb, opacity
layout(location = 3) in vec4  aShape;    // sides, corner phase, family, aux
uniform vec2 uAtlasDim;                  // atlas cells across, down
out vec3  vTint;
out float vAlpha;
out float vEdge;
out vec2  vGlyph;
const float TAU = 6.28318530718;
const float RIM = 25.0;
void main() {
  vec2 local = vec2(0.0);
  vec2 uv = vec2(0.5);
  vEdge = 0.0;
  if (aCorner > 0.5) {
    float k = aCorner - 1.0;              // 0..25 around the fan, 25 closing it
    float fam = aShape.z;
    if (fam < 1.5) {
      // Polygon and star are the same walk; the star just has twice the corners
      // and pulls every other one in to aShape.w.
      float n = fam < 0.5 ? aShape.x : aShape.x * 2.0;
      float corner = floor(k * n / RIM);
      float a = corner / n * TAU + aShape.y;
      float rr = (fam < 0.5 || mod(corner, 2.0) < 0.5) ? 1.0 : aShape.w;
      local = vec2(cos(a), sin(a)) * rr;
    } else {
      // Four corners at 45 degrees: the square inscribed in the shard's disc,
      // so a glyph is exactly as big as the collision radius says it is.
      float corner = floor(k * 4.0 / RIM);
      float a = corner * (TAU * 0.25) + 0.78539816;
      vec2 c = vec2(cos(a), sin(a));
      uv = c * 0.70710678 + 0.5;
      if (fam < 2.5) c.y *= aShape.w;     // sliver: squash to a needle
      local = c;
    }
    vEdge = 1.0;
  }
  local *= aXform.w;
  float c = cos(aXform.z), s = sin(aXform.z);
  vec2 p = vec2(local.x * c - local.y * s, local.x * s + local.y * c) + aXform.xy;
  gl_Position = vec4(p, 0.0, 1.0);   // cell space IS clip space: the FBO is square
  vTint  = aTint.rgb;
  vAlpha = aTint.a;
  // The atlas is laid out left-to-right, top-to-bottom, and is uploaded
  // unflipped — so the v axis runs the other way from the cell's y.
  float idx = aShape.w;
  vGlyph = vec2(mod(idx, uAtlasDim.x) + uv.x,
                floor(idx / uAtlasDim.x) + (1.0 - uv.y)) / uAtlasDim;
}`;

// Three blend behaviours share one shader:
//   uGlyph 0, uGlint 0 — stained glass. Blended with (ZERO, SRC_COLOR), i.e.
//       dst *= src, so overlapping shards multiply exactly the way stacked
//       colour filters do: two greens deepen, red over green goes near-black.
//       Fully transparent fragments emit white, the identity for a multiply.
//   uGlyph 0, uGlint 1 — bevel glint. Additive, confined to the outer rim, for
//       the specular catch off a shard's cut edge.
//   uGlyph 1 — the glyph atlas, multiplied the same way as the glass. uNative
//       decides whether an emoji keeps its own colours or gets tinted by the
//       palette; white text multiplied by the tint IS the tint, so one path
//       covers letters and emoji both.
export const SHARD_FS = `#version 300 es
precision highp float;
in vec3  vTint;
in float vAlpha;
in float vEdge;
in vec2  vGlyph;
uniform float uGlint;
uniform float uGlyph;
uniform float uNative;
uniform sampler2D uAtlas;
out vec4 outColor;
void main() {
  if (uGlyph > 0.5) {
    vec4 g = texture(uAtlas, vGlyph);
    float a = g.a * vAlpha;
    if (a < 0.004) { outColor = vec4(1.0, 1.0, 1.0, 0.0); return; }
    vec3 ink = mix(vTint * g.rgb, g.rgb, uNative);
    outColor = vec4(mix(vec3(1.0), ink, a), a);
    return;
  }
  float bevel = smoothstep(0.72, 1.0, vEdge);
  if (uGlint > 0.5) {
    float rim = pow(bevel, 6.0);
    outColor = vec4(mix(vTint, vec3(1.0), 0.55) * rim * vAlpha, 1.0);
    return;
  }
  vec3 tint = mix(vTint, min(vTint * 1.5, vec3(1.0)), bevel * 0.45);
  outColor = vec4(mix(vec3(1.0), tint, vAlpha), vAlpha);
}`;

// ---------------------------------------------------------------------------
// Tube pass
// ---------------------------------------------------------------------------
// uMode 0 is the two-mirror V of a toy kaleidoscope: its images are a rosette of
// 2N sectors around the axis, so folding is a modulo plus a mirror in polar
// coordinates.
//
// uMode 1 is a three-mirror tube, whose images do not form a rosette at all —
// they TILE THE PLANE with reflected copies of the triangular window. That is
// the Euclidean triangle group, and the fold is iterated reflection into the
// fundamental triangle: while the point is outside, reflect it across whichever
// mirror it is furthest beyond. Sixteen iterations reach the domain for any zoom
// worth looking at.
//
// Both branches count reflections, because real mirrors are not free: each
// bounce costs a few percent of the light and warms it slightly. Applying
// reflectance^bounces is what gives the image its authentic falloff toward the
// rim, where the light has bounced a dozen times to reach the eye.
//
// uVision is the one part of this pass that is not optics: a colour-vision
// deficiency matrix, applied last, so a palette can be checked against what a
// dichromat actually sees rather than against what it is supposed to be.
export const TUBE_FS = `#version 300 es
precision highp float;
uniform sampler2D uCell;
uniform vec2  uRes;
uniform float uZoom;
uniform float uRoll;
uniform int   uMode;
uniform float uSectors;
uniform vec2  uMirrorO[3];
uniform vec2  uMirrorN[3];
uniform vec2  uTriCenter;
uniform float uTriScale;
uniform vec3  uReflect;
uniform float uAberration;
uniform float uSeam;
uniform float uAperture;
uniform float uVignette;
uniform mat3  uVision;
out vec4 outColor;
const float TAU = 6.28318530718;

vec3 sampleCell(vec2 q, float aberr) {
  // Radial dispersion: the wavelengths take slightly different paths through
  // the glass, so red and blue land at different radii.
  vec3 c;
  c.r = texture(uCell, q * (1.0 + aberr) * 0.5 + 0.5).r;
  c.g = texture(uCell, q * 0.5 + 0.5).g;
  c.b = texture(uCell, q * (1.0 - aberr) * 0.5 + 0.5).b;
  return c;
}

void main() {
  vec2 frag = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float viewR = length(frag) * 2.0;

  float cr = cos(uRoll), sr = sin(uRoll);
  vec2 p = mat2(cr, -sr, sr, cr) * (frag * 2.0 * uZoom);

  vec2 q;
  float bounces;
  float edge;   // distance to the nearest mirror, for the seam highlight

  if (uMode == 0) {
    float rad = length(p);
    float ang = atan(p.y, p.x);
    float half_ = 3.14159265359 / uSectors;
    float h = ang / half_;
    float idx = floor(h);
    float f = h - idx;
    float folded = mod(idx, 2.0) < 0.5 ? f : 1.0 - f;   // alternate handedness
    float a = folded * half_;
    bounces = abs(idx);
    edge = min(folded, 1.0 - folded) * half_ * rad;
    q = vec2(cos(a), sin(a)) * rad;
  } else {
    q = p;
    bounces = 0.0;
    float worst = 0.0;
    // Sweep all three mirrors in order each pass, reflecting across any the
    // point is still outside. Reflecting only across the single worst offender
    // is the obvious greedy version and it does not reliably converge — it can
    // ping-pong between two mirrors and leave far-out points unfolded, which
    // shows up as flat unresolved patches in the corners of a wide view.
    for (int i = 0; i < 24; i++) {
      worst = -1.0;
      for (int k = 0; k < 3; k++) {
        float d = dot(q - uMirrorO[k], uMirrorN[k]);
        worst = max(worst, d);
        if (d > 0.0) { q -= 2.0 * d * uMirrorN[k]; bounces += 1.0; }
      }
      if (worst <= 0.0) break;
    }
    // Recompute the final clearance: the loop's own 'worst' is from before
    // its last round of reflections, so it is not the clearance we want.
    edge = 1e9;
    for (int k = 0; k < 3; k++) edge = min(edge, -dot(q - uMirrorO[k], uMirrorN[k]));
    q = (q - uTriCenter) * uTriScale;
  }

  // Past the rim of the object cell there is no glass, only the dark inside of
  // the tube — so the rosette sits on black rather than on a smeared clamp of
  // the texture's edge pixels.
  float inCell = smoothstep(1.0, 0.955, length(q));

  vec3 col = sampleCell(q, uAberration);
  col *= pow(uReflect, vec3(bounces));
  col = mix(vec3(0.015, 0.015, 0.02), col, inCell);

  // Mirror seams: a real tube's mirror joints catch a thin line of light.
  col += uSeam * 0.35 * exp(-edge * 430.0) * vec3(0.85, 0.92, 1.0) * inCell;

  // Eyepiece: you are looking down a tube, so the field of view is a circle.
  float ap = mix(1.0, smoothstep(0.98, 0.90, viewR), uAperture);
  col *= ap;
  col *= mix(1.0, smoothstep(1.55, 0.25, viewR), uVignette);

  outColor = vec4(clamp(uVision * col, 0.0, 1.0), 1.0);
}`;
