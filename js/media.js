// Live backdrops for the object cell — camera, screen share, or a file the
// user drops on the page.
//
// In a real kaleidoscope the object cell is lit from behind through a frosted
// plate, and the fancy ones ("teleidoscopes") replace the cell with a lens that
// looks at whatever is in front of you. Both are the same thing to this code:
// the backlight pass gets a picture instead of a radial falloff, the glass
// multiplies over it, and the mirror tube folds the result. So a camera or a
// video is not a special render path — it is one texture swapped into pass one.
//
// This module owns only the DOM and stream side of that: it produces a
// paintable element and says when it has a new frame. The texture belongs to
// the renderer, which is where every other GL object lives.
//
// What is NOT here, deliberately: YouTube. A YouTube embed is a cross-origin
// iframe, and there is no API — in any browser — that lets a page read pixels
// out of one. drawImage/texImage2D on it throws, and even if it did not, the
// player is DRM-fenced. The working route to "a kaleidoscope of that video" is
// the screen share below: start it, pick the tab playing the video, done.
//
// What is NOT here on one platform: the screen share itself. iOS and iPadOS
// have no screen-capture API — getDisplayMedia is simply absent, and it is
// absent from every browser on the platform, because Chrome and Firefox there
// are skins over the same WebKit. There is no shim and no permission to grant;
// the honest answer is the camera or a file instead. The checks in use() below
// exist to say that in words, because the alternative is a bare "undefined is
// not a function" in the console and a picker that appears to do nothing.

const isSecure = typeof isSecureContext === 'undefined' ? true : isSecureContext;

// A Permissions-Policy response header can switch the camera off for the whole
// document, and when it does getUserMedia rejects with NotAllowedError — the
// same error the user gets for clicking "Block", which sends people hunting
// through browser settings for a permission that was never theirs to give.
// Chrome exposes the policy, so ask it first and say which of the two it is.
// Other engines do not, and there the attempt is the only way to find out.
function policyBlocks(feature) {
  const fp = typeof document !== 'undefined' && (document.featurePolicy || document.permissionsPolicy);
  if (!fp || typeof fp.allowsFeature !== 'function') return false;
  try { return !fp.allowsFeature(feature); } catch (_) { return false; }
}

export class MediaInput {
  constructor(onChange) {
    this.kind = 'off';        // off | camera | screen | file
    this.ready = false;
    this.dirty = false;
    this.status = '';
    this.label = '';
    this.aspect = 1;
    this.scale = new Float32Array([1, 1]);   // cover-fit into the square cell
    this.source = null;

    this._onChange = onChange || (() => {});
    this._stream = null;
    this._url = null;
    this._live = false;
    this._lastTime = -1;
    this._token = 0;

    const v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.playsInline = true;
    v.loop = true; v.autoplay = true; v.crossOrigin = 'anonymous';
    v.setAttribute('playsinline', '');
    this._video = v;
    this._image = new Image();
    this._image.crossOrigin = 'anonymous';
  }

  // Switch source. `file` is required for kind === 'file'. Rejections are
  // reported through `status` rather than thrown: a denied camera permission is
  // a normal outcome, not an error the frame loop should care about.
  async use(kind, file) {
    const token = ++this._token;
    this.stop();
    this.kind = kind;
    if (kind === 'off') { this._onChange(this); return true; }

    try {
      if (kind === 'camera' || kind === 'screen') {
        if (!isSecure) throw new Error('needs https');
        const md = navigator.mediaDevices;
        if (!md) throw new Error('no media devices API');
        const feature = kind === 'camera' ? 'camera' : 'display-capture';
        if (policyBlocks(feature)) {
          throw new Error(`blocked by this site's Permissions-Policy header (${feature})`);
        }
        // Feature-detect before the call, and name the real cause. A missing
        // getDisplayMedia is not a permission problem and not something a
        // reload or a settings hunt fixes: on iOS and iPadOS the API does not
        // exist in any browser, so there is nothing to enable.
        if (kind === 'screen' && typeof md.getDisplayMedia !== 'function') {
          throw new Error('this browser has no screen capture — iOS and iPadOS '
            + 'have no such API at all, in any browser. Use the camera or a file.');
        }
        if (kind === 'camera' && typeof md.getUserMedia !== 'function') {
          throw new Error('this browser has no camera capture API');
        }
        const stream = kind === 'camera'
          ? await md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          : await md.getDisplayMedia({ video: { frameRate: { ideal: 60 } }, audio: false });
        if (token !== this._token) { stream.getTracks().forEach((t) => t.stop()); return false; }
        this._stream = stream;
        // The user can stop a screen share from the browser's own bar; that has
        // to put the backdrop back rather than freeze on the last frame.
        for (const t of stream.getTracks()) {
          t.addEventListener('ended', () => { if (this._stream === stream) this.revert('sharing ended'); });
        }
        this.label = kind === 'camera' ? 'camera' : 'screen share';
        await this._playVideo(stream, null);
      } else if (kind === 'file') {
        if (!file) throw new Error('no file chosen');
        this._url = URL.createObjectURL(file);
        this.label = file.name;
        if (file.type.startsWith('video/')) await this._playVideo(null, this._url);
        else await this._showImage(this._url);
      }
      if (token !== this._token) return false;
      this.status = '';
    } catch (err) {
      if (token !== this._token) return false;
      this.stop();
      this.kind = 'off';
      this.status = describe(err);
      this._onChange(this);
      return false;
    }
    this._onChange(this);
    return true;
  }

  revert(why) {
    this.stop();
    this.kind = 'off';
    this.status = why || '';
    this._onChange(this);
  }

  _playVideo(stream, url) {
    const v = this._video;
    if (stream) v.srcObject = stream; else v.src = url;
    this._live = true;
    return new Promise((resolve, reject) => {
      const ok = () => { cleanup(); this._onVideoReady(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('the file could not be decoded')); };
      const cleanup = () => {
        v.removeEventListener('loadeddata', ok);
        v.removeEventListener('error', bad);
      };
      v.addEventListener('loadeddata', ok, { once: true });
      v.addEventListener('error', bad, { once: true });
      v.play().catch(() => { /* autoplay of a muted video; loadeddata still fires */ });
    });
  }

  _onVideoReady() {
    const v = this._video;
    this.source = v;
    this.ready = true;
    this.dirty = true;
    this._setAspect(v.videoWidth || 16, v.videoHeight || 9);
    // A screen share changes size when the shared window does, and a stream's
    // track can renegotiate mid-flight. The texture reallocates on its own, but
    // the cover-fit scale would be left cropping to the old aspect.
    if (!this._sized) {
      this._sized = () => this._setAspect(v.videoWidth, v.videoHeight);
      v.addEventListener('resize', this._sized);
    }
    // requestVideoFrameCallback fires exactly when a new frame is available, so
    // the texture upload happens once per decoded frame instead of once per
    // rendered frame — which matters when the display is at 240 Hz and the
    // camera is at 30.
    if (v.requestVideoFrameCallback) {
      const pump = () => {
        if (!this._live) return;
        this.dirty = true;
        v.requestVideoFrameCallback(pump);
      };
      v.requestVideoFrameCallback(pump);
    }
  }

  _showImage(url) {
    const img = this._image;
    return new Promise((resolve, reject) => {
      img.onload = () => {
        this.source = img;
        this.ready = true;
        this.dirty = true;
        this._setAspect(img.naturalWidth, img.naturalHeight);
        resolve();
      };
      img.onerror = () => reject(new Error('the image could not be decoded'));
      img.src = url;
    });
  }

  _setAspect(w, h) {
    const a = (w && h) ? w / h : 1;
    this.aspect = a;
    // Cover, not contain: the cell is square and the source rarely is, so the
    // short side maps to the full cell and the long one is cropped. Letterbox
    // bars would be folded by the mirrors into hard black wedges.
    if (a >= 1) { this.scale[0] = 1 / a; this.scale[1] = 1; }
    else { this.scale[0] = 1; this.scale[1] = a; }
  }

  // Called once a frame. Only does anything for a video on a browser without
  // requestVideoFrameCallback, where the decoded-frame clock is invisible and
  // the current time is the only signal there is.
  poll() {
    if (!this.ready || this.source !== this._video) return;
    if (this._video.requestVideoFrameCallback) return;
    const t = this._video.currentTime;
    if (t !== this._lastTime) { this._lastTime = t; this.dirty = true; }
  }

  stop() {
    this._live = false;
    this.ready = false;
    this.dirty = false;
    this.source = null;
    this.label = '';
    this._lastTime = -1;
    if (this._stream) {
      for (const t of this._stream.getTracks()) t.stop();
      this._stream = null;
    }
    const v = this._video;
    v.pause();
    v.srcObject = null;
    v.removeAttribute('src');
    v.load();
    this._image.removeAttribute('src');
    if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
  }
}

function describe(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'permission refused';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no camera found';
  if (name === 'NotReadableError') return 'the device is in use by something else';
  if (name === 'AbortError') return 'cancelled';
  return String((err && err.message) || err);
}
