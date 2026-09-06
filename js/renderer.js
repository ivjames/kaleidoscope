// WebGL2 renderer: two passes, no per-frame allocation, no state churn.
//
//   pass 1  object cell -> offscreen square texture (one instanced draw)
//   pass 2  mirror tube -> default framebuffer (one full-screen triangle)
//
// Three textures, on three fixed units, bound once and never rebound:
//   0  the cell FBO's colour attachment, read by the tube pass
//   1  the glyph atlas, read by the shard pass when the cell is text or emoji
//   2  the backdrop (camera, screen share, file), read by the backlight pass
//
// Splitting it this way is not just tidy: the cell is drawn once at whatever
// resolution the glass actually needs (512-1024 is plenty for chips a few
// pixels across), while the fold runs at full display resolution. Raising the
// window size therefore costs one cheap pass, not two.

import { FULLSCREEN_VS, BACKLIGHT_FS, SHARD_VS, SHARD_FS, TUBE_FS } from './shaders.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('shader compile failed: ' + log);
  }
  return sh;
}

function link(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs); gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs); gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('program link failed: ' + log);
  }
  return p;
}

function uniforms(gl, program, names) {
  const u = {};
  for (const n of names) u[n] = gl.getUniformLocation(program, n);
  return u;
}

// --- mirror tube geometry ---------------------------------------------------
//
// A three-mirror tube is a Euclidean triangle group: the mirrors bound one
// triangle, and the reflected images tile the plane with copies of it. Only
// three triangles tile that way — the ones whose angles are pi/p, pi/q, pi/r
// with 1/p + 1/q + 1/r = 1 — and those are exactly the three mirror tubes a
// kaleidoscope maker can cut. Everything else leaves a seam.
//
// Given p and q the third angle follows, so this builds the triangle from two
// numbers, recentres it on its own centroid (so the view looks down the middle
// of a triangle rather than into a corner), and returns each edge as an
// outward-pointing mirror plane for the shader to reflect across.
export function triangleTube(p, q) {
  const A = Math.PI / p, B = Math.PI / q, C = Math.PI - A - B;
  const L = 1;
  const lenAC = L * Math.sin(B) / Math.sin(C);
  let verts = [
    [0, 0],
    [L, 0],
    [lenAC * Math.cos(A), lenAC * Math.sin(A)],
  ];
  const gx = (verts[0][0] + verts[1][0] + verts[2][0]) / 3;
  const gy = (verts[0][1] + verts[1][1] + verts[2][1]) / 3;
  verts = verts.map(([x, y]) => [x - gx, y - gy]);

  // Normalise every tube to the same bore. A real kaleidoscope's tube diameter
  // is fixed and only the mirror angles change, so the fundamental triangles
  // are inscribed in one circle — without this the 30-60-90 tube would appear
  // to zoom in relative to the equilateral one purely because its triangle is
  // built larger.
  const bore = Math.max(...verts.map(([x, y]) => Math.hypot(x, y)));
  verts = verts.map(([x, y]) => [x * 0.5 / bore, y * 0.5 / bore]);

  const origins = new Float32Array(6);
  const normals = new Float32Array(6);
  let maxDist = 0;
  for (let i = 0; i < 3; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % 3];
    let nx = y2 - y1, ny = -(x2 - x1);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (-x1 * nx + -y1 * ny > 0) { nx = -nx; ny = -ny; }   // point away from the centroid
    origins[i * 2] = x1; origins[i * 2 + 1] = y1;
    normals[i * 2] = nx; normals[i * 2 + 1] = ny;
    maxDist = Math.max(maxDist, Math.hypot(x1, y1));
  }
  // The triangular window is inscribed in the round object cell, so scale the
  // folded point by the largest vertex radius to fill the disc without
  // sampling past its edge.
  return { origins, normals, scale: 0.88 / maxDist, angles: [p, q, Math.round(Math.PI / C)] };
}

export const TUBES = {
  rosette: { label: '2-mirror V', mode: 0 },
  '333':   { label: '3-mirror equilateral', mode: 1, tri: triangleTube(3, 3) },
  '236':   { label: '3-mirror 30-60-90',    mode: 1, tri: triangleTube(2, 3) },
  '244':   { label: '3-mirror 45-45-90',    mode: 1, tri: triangleTube(2, 4) },
};

// Fan size and instance-buffer stride, shared with the shard shaders. Both are
// baked into SHARD_VS (RIM = 25, aShape = vec4), so they move together.
const FAN_VERTS = 27;
const STYLE_FLOATS = 8;
const STYLE_STRIDE = STYLE_FLOATS * 4;

export class Renderer {
  constructor(canvas, maxShards) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is unavailable in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.maxShards = maxShards;

    this.progBack = link(gl, FULLSCREEN_VS, BACKLIGHT_FS);
    this.progShard = link(gl, SHARD_VS, SHARD_FS);
    this.progTube = link(gl, FULLSCREEN_VS, TUBE_FS);

    this.uBack = uniforms(gl, this.progBack, [
      'uRes', 'uWarm', 'uCool', 'uMedia', 'uMediaMix', 'uMediaScale', 'uMediaGain',
    ]);
    this.uShard = uniforms(gl, this.progShard, ['uGlint', 'uGlyph', 'uNative', 'uAtlas', 'uAtlasDim']);
    this.uTube = uniforms(gl, this.progTube, [
      'uCell', 'uRes', 'uZoom', 'uRoll', 'uMode', 'uSectors',
      'uMirrorO[0]', 'uMirrorN[0]', 'uTriCenter', 'uTriScale',
      'uReflect', 'uAberration', 'uSeam', 'uAperture', 'uVignette', 'uVision',
    ]);

    // Sampler bindings are program state, not draw state: set once at link time
    // and the frame loop never touches a texture unit again.
    gl.useProgram(this.progBack);  gl.uniform1i(this.uBack.uMedia, 2);
    gl.useProgram(this.progShard); gl.uniform1i(this.uShard.uAtlas, 1);
    gl.useProgram(this.progTube);  gl.uniform1i(this.uTube.uCell, 0);

    // Static fan: centre plus 26 rim vertices. The vertex shader decides where
    // each one lands — n-gon, star, sliver or glyph quad — so one buffer covers
    // every shape in the cell and shapes with fewer corners simply emit
    // repeated vertices the rasteriser throws away.
    const corners = new Float32Array(FAN_VERTS);
    for (let i = 0; i < FAN_VERTS; i++) corners[i] = i;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.bufCorner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufCorner);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);

    this.bufXform = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufXform);
    gl.bufferData(gl.ARRAY_BUFFER, maxShards * 4 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    this.bufStyle = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufStyle);
    gl.bufferData(gl.ARRAY_BUFFER, maxShards * STYLE_STRIDE, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STYLE_STRIDE, 0);    // rgb + alpha
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, STYLE_STRIDE, 16);   // sides, phase, family, aux
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);

    this.cellRes = 0;
    this.fbo = gl.createFramebuffer();
    this.cellTex = gl.createTexture();
    this.setCellResolution(768);

    // Unit 1: the glyph atlas. Starts as a single opaque white texel, which is
    // the identity for the tint — so a glyph draw before the first atlas build
    // shows plain squares rather than sampling undefined memory.
    this.atlasDim = [1, 1];
    this.atlasTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Unit 2: the backdrop. Same idea — white until something is loaded.
    this.mediaW = 0; this.mediaH = 0;
    this.mediaTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.mediaTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);

    // Optional GPU-side timing. One query in flight: enough for a HUD reading,
    // and it never stalls the pipeline waiting for a result.
    this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.query = null;
    this.gpuMs = null;

    this.renderer = 'WebGL2';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) this.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || this.renderer;
  }

  setCellResolution(res) {
    if (res === this.cellRes) return;
    const gl = this.gl;
    this.cellRes = res;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cellTex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error('cell framebuffer incomplete: 0x' + status.toString(16));
  }

  // Replace the glyph atlas. Called only when the character set changes — the
  // sheet is a canvas the caller has already rasterised, and mipmaps are worth
  // the one-off cost because a cell full of small glyphs shimmers badly without
  // them.
  setAtlas(canvas, cols, rows) {
    const gl = this.gl;
    this.atlasDim[0] = cols;
    this.atlasDim[1] = rows;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Push one frame of the backdrop. The caller decides when: for a video that
  // is once per decoded frame, not once per rendered frame, which is the whole
  // difference between a 30 Hz camera costing 30 uploads a second and 240.
  uploadMedia(src) {
    const gl = this.gl;
    const w = src.videoWidth || src.naturalWidth || src.width;
    const h = src.videoHeight || src.naturalHeight || src.height;
    if (!w || !h) return false;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.mediaTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      // Reallocating the texture storage on every frame of a 720p camera is
      // pure waste — the size only changes when the source does, so after the
      // first frame this is a sub-image write into storage that already exists.
      if (w === this.mediaW && h === this.mediaH) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
        this.mediaW = w; this.mediaH = h;
      }
    } catch (_) {
      this.mediaW = 0; this.mediaH = 0;
      gl.activeTexture(gl.TEXTURE0);
      return false;   // a tainted or not-yet-decodable source
    }
    gl.activeTexture(gl.TEXTURE0);
    return true;
  }

  resize(cssW, cssH, scale) {
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (w === this.canvas.width && h === this.canvas.height) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    return true;
  }

  beginTiming() {
    const ext = this.timerExt;
    if (!ext) return;
    if (this.query) {
      const gl = this.gl;
      const done = gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE);
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (done) {
        if (!disjoint) this.gpuMs = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
        this.gl.deleteQuery(this.query);
        this.query = null;
      } else {
        return;   // still in flight; skip this frame's measurement
      }
    }
    this.query = this.gl.createQuery();
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, this.query);
    this.timing = true;
  }

  endTiming() {
    if (this.timing) {
      this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
      this.timing = false;
    }
  }

  uploadCell(cell) {
    const gl = this.gl;
    const nX = cell.packTransforms();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufXform);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, cell.xform, 0, nX);
    if (cell.styleDirty) {
      const nS = cell.packStyle();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufStyle);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, cell.style, 0, nS);
    }
  }

  drawCell(cell, opts) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.cellRes, this.cellRes);

    gl.disable(gl.BLEND);
    gl.useProgram(this.progBack);
    gl.uniform2f(this.uBack.uRes, this.cellRes, this.cellRes);
    gl.uniform3fv(this.uBack.uWarm, opts.warm);
    gl.uniform3fv(this.uBack.uCool, opts.cool);
    gl.uniform1f(this.uBack.uMediaMix, opts.mediaMix);
    gl.uniform2fv(this.uBack.uMediaScale, opts.mediaScale);
    gl.uniform1f(this.uBack.uMediaGain, opts.mediaGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(this.vao);
    gl.useProgram(this.progShard);

    // Stained glass: dst *= src. Overlapping shards multiply, which is what
    // stacked colour filters do — and transparent fragments emit white, the
    // identity, so there is nothing to mask out.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
    gl.uniform1f(this.uShard.uGlyph, opts.glyph ? 1 : 0);
    gl.uniform1f(this.uShard.uNative, opts.native ? 1 : 0);
    gl.uniform2f(this.uShard.uAtlasDim, this.atlasDim[0], this.atlasDim[1]);
    gl.uniform1f(this.uShard.uGlint, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, FAN_VERTS, cell.count);

    // No glint pass in glyph mode: the bevel is a property of a cut edge, and a
    // letter's edge is the atlas's alpha, not the quad it is drawn on.
    if (opts.glints && !opts.glyph) {
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(this.uShard.uGlint, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, FAN_VERTS, cell.count);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  drawTube(opts) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.progTube);

    const u = this.uTube;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uZoom, opts.zoom);
    gl.uniform1f(u.uRoll, opts.roll);
    gl.uniform1i(u.uMode, opts.mode);
    gl.uniform1f(u.uSectors, opts.sectors);
    gl.uniform2fv(u['uMirrorO[0]'], opts.origins);
    gl.uniform2fv(u['uMirrorN[0]'], opts.normals);
    gl.uniform2f(u.uTriCenter, 0, 0);
    gl.uniform1f(u.uTriScale, opts.triScale);
    gl.uniform3f(u.uReflect, opts.reflect, opts.reflect * 0.994, opts.reflect * 0.987);
    gl.uniform1f(u.uAberration, opts.aberration);
    gl.uniform1f(u.uSeam, opts.seam);
    gl.uniform1f(u.uAperture, opts.aperture);
    gl.uniform1f(u.uVignette, opts.vignette);
    gl.uniformMatrix3fv(u.uVision, false, opts.vision);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
