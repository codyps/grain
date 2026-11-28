/* X-T4 film grain — local, installable PWA.
 *
 * Corrected model from uncompressed X-T4 RAF conversions (ISO 400, Provia,
 * DR100; firmware 2.12):
 *   Small: triangular noise + separable 5-tap band-pass
 *          kernel [-0.06, 0.107, 1, 0.107, -0.06]
 *          weak std 8.25, strong std 17.05
 *   Large: Gaussian noise + separable 3-tap low-pass
 *          kernel [0, 0.79, 1, 0.79, 0]
 *          weak std 4.02, strong std 8.45
 * The amplitude follows the measured output-luma curve (black suppression and
 * highlight rolloff). Acros/B&W is 0.86x with a tighter Large kernel. The same
 * monochrome field is added to R/G/B and clipped to 0..255.
 */
(() => {
  'use strict';

  const MODEL = {
    small: {
      weak: { std: 8.25, k1: 0.107, k2: -0.06 },
      strong: { std: 17.05, k1: 0.107, k2: -0.06 },
    },
    large: {
      weak: { std: 4.02, k1: 0.79, k2: 0 },
      strong: { std: 8.45, k1: 0.79, k2: 0 },
    },
  };

  const ACROS = {
    scale: 0.86,
    large: { k1: 0.42, k2: 0.05 },
  };

  const DEFAULTS = {
    version: 2,
    size: 'large',
    strength: 'strong',
    film: 'color',
    amount: 100,
    seed: 517,
    tone: true,
    maxEdge: 0,
    format: 'jpeg',
  };

  const STORAGE_KEY = 'xt4grain.settings.v1';
  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'),
    viewer: $('viewer'),
    frame: $('frame'),
    view: $('view'),
    original: $('original'),
    canvasWrap: $('canvasWrap'),
    empty: $('empty'),
    emptyCamera: $('emptyCamera'),
    emptyPhotos: $('emptyPhotos'),
    busy: $('busy'),
    toast: $('toast'),
    compareBtn: $('compareBtn'),
    fitBtn: $('fitBtn'),
    zoomLabel: $('zoomLabel'),
    rotateBtn: $('rotateBtn'),
    saveBtn: $('saveBtn'),
    takeBtn: $('takeBtn'),
    chooseBtn: $('chooseBtn'),
    cameraInput: $('cameraInput'),
    galleryInput: $('galleryInput'),
    cameraView: $('cameraView'),
    cameraVideo: $('cameraVideo'),
    cameraClose: $('cameraClose'),
    cameraFlip: $('cameraFlip'),
    cameraShutter: $('cameraShutter'),
    cameraPhotos: $('cameraPhotos'),
    cameraStatus: $('cameraStatus'),
    cameraLoading: $('cameraLoading'),
    cameraError: $('cameraError'),
    cameraErrorText: $('cameraErrorText'),
    cameraRetry: $('cameraRetry'),
    cameraFallback: $('cameraFallback'),
    cameraErrorPhotos: $('cameraErrorPhotos'),
    cameraErrorClose: $('cameraErrorClose'),
    amount: $('amount'),
    amountOut: $('amountOut'),
    barAmount: $('barAmount'),
    sizeValue: $('sizeValue'),
    strengthValue: $('strengthValue'),
    filmValue: $('filmValue'),
    seedOut: $('seedOut'),
    shuffleBtn: $('shuffleBtn'),
    tone: $('tone'),
    resolution: $('resolution'),
    resetBtn: $('resetBtn'),
    installBtn: $('installBtn'),
    installRow: $('installRow'),
    iosHint: $('iosHint'),
    info: $('info'),
  };

  let state = loadSettings();
  let source = null;        // { bitmap, w, h, rotation, url? }
  let work = null;          // { canvas, w, h }
  let renderer = null;
  let renderTimer = 0;
  let toastTimer = 0;
  let busyCount = 0;
  let cameraStream = null;
  let cameraFacing = 'environment';
  let cameraActive = false;
  let cameraStarting = false;
  let cameraRequest = 0;
  const viewState = { scale: 1, x: 0, y: 0 };

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    const s = { ...DEFAULTS };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.size === 'small' || raw.size === 'large') s.size = raw.size;
      if (raw.strength === 'weak' || raw.strength === 'strong') s.strength = raw.strength;
      if (raw.film === 'color' || raw.film === 'acros') s.film = raw.film;
      if (Number.isFinite(raw.amount)) s.amount = Math.max(0, Math.min(200, Math.round(raw.amount)));
      if (Number.isFinite(raw.seed)) s.seed = Math.max(0, Math.min(4095, Math.round(raw.seed)));
      if (typeof raw.tone === 'boolean') s.tone = raw.tone;
      else if (typeof raw.gate === 'boolean') s.tone = raw.gate;
      if ([0, 2048, 3072, 4096].includes(raw.maxEdge)) s.maxEdge = raw.maxEdge;
      if (raw.format === 'jpeg' || raw.format === 'png') s.format = raw.format;
      if ((!raw.version || raw.version < 2) && raw.maxEdge === 4096) s.maxEdge = 0;
      s.version = 2;
    } catch (_) { /* ignore corrupt storage */ }
    return s;
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* private mode */ }
  }

  // ------------------------------------------------------------- model math

  function kw(d, k1, k2) {
    const a = Math.abs(d);
    return a < 0.5 ? 1 : (a < 1.5 ? k1 : k2);
  }

  function modelParams(size, strength, film) {
    const m = MODEL[size][strength];
    const acros = film === 'acros';
    const scale = acros ? ACROS.scale : 1;
    if (acros && size === 'large') {
      return {
        std: m.std * scale,
        k1: ACROS.large.k1,
        k2: ACROS.large.k2,
        dist: 1, // Gaussian source
        radius: 2,
        variance: 1,
      };
    }
    return {
      std: m.std * scale,
      k1: m.k1,
      k2: m.k2,
      dist: size === 'small' ? 0 : 1, // triangular / Gaussian
      radius: m.k2 !== 0 ? 2 : 1,
      variance: size === 'small' ? 2 / 3 : 1,
    };
  }

  /** Convert the measured 8-bit target std into the shader's gain. */
  function computeGain(size, strength, amount, film) {
    const p = modelParams(size, strength, film);
    const std = p.std * (amount / 100);
    const norm = 1 + 2 * p.k1 + 2 * p.k2;
    let sumW2 = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const w = (kw(dx, p.k1, p.k2) * kw(dy, p.k1, p.k2)) / (norm * norm);
        sumW2 += w * w;
      }
    }
    return std / Math.sqrt(p.variance * sumW2);
  }

  function modelLabel() {
    const size = state.size === 'small' ? 'Small' : 'Large';
    const strength = state.strength === 'weak' ? 'Weak' : 'Strong';
    const film = state.film === 'acros' ? 'Acros' : 'Color';
    return `${size} · ${strength} · ${film} · ${state.amount}%`;
  }

  // --------------------------------------------------------------- renderer

  const VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform sampler2D u_image;
    uniform float u_seed;
    uniform float u_gain;
    uniform float u_dist;
    uniform float u_radius;
    uniform float u_k1;
    uniform float u_k2;
    uniform float u_tone;
    varying vec2 v_uv;

    float hash(vec2 p, float seed) {
      float s = mod(seed, 4096.0);
      p += vec2(s * 0.137, s * 0.271);
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    // White source for the measured field. Small uses a triangular source
    // (sum of two uniforms), Large a Gaussian source.
    float source(vec2 p, float seed) {
      if (u_dist < 0.5) {
        float u = hash(p, seed);
        float v = 2.0 * u - 1.0;
        return 2.0 * sign(v) * (1.0 - sqrt(abs(v)));
      }
      float u1 = max(hash(p, seed), 1e-6);
      float u2 = hash(p + vec2(37.0, 17.0), seed + 1.0);
      return sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2);
    }

    float kw(float d) {
      d = abs(d);
      return d < 0.5 ? 1.0 : (d < 1.5 ? u_k1 : u_k2);
    }

    // Measured amplitude vs output luma: black suppression, flat midtones,
    // highlight rolloff. Values from the X-T4 step-wedge calibration.
    float toneGain(float y) {
      if (y <= 0.0) return 0.0;
      if (y < 16.0) return y / 16.0;
      if (y < 179.0) return mix(1.0, 0.957, (y - 16.0) / 163.0);
      if (y < 202.0) return mix(0.957, 0.864, (y - 179.0) / 23.0);
      if (y < 214.0) return mix(0.864, 0.781, (y - 202.0) / 12.0);
      if (y < 224.0) return mix(0.781, 0.749, (y - 214.0) / 10.0);
      if (y < 237.0) return mix(0.749, 0.717, (y - 224.0) / 13.0);
      if (y < 248.0) return mix(0.717, 0.521, (y - 237.0) / 11.0);
      if (y < 254.0) return mix(0.521, 0.186, (y - 248.0) / 6.0);
      if (y < 255.0) return mix(0.186, 0.03, (y - 254.0) / 1.0);
      return 0.03;
    }

    void main() {
      vec3 c = texture2D(u_image, v_uv).rgb;
      float norm = 1.0 + 2.0 * u_k1 + 2.0 * u_k2;
      float n = 0.0;
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          if (abs(float(dx)) <= u_radius && abs(float(dy)) <= u_radius) {
            float w = kw(float(dx)) * kw(float(dy));
            n += source(gl_FragCoord.xy + vec2(float(dx), float(dy)), u_seed) * w;
          }
        }
      }
      n /= (norm * norm);
      float luma = dot(c, vec3(0.299, 0.587, 0.114)) * 255.0;
      float tone = mix(1.0, toneGain(luma), u_tone);
      gl_FragColor = vec4(clamp(c + vec3(n * u_gain * tone / 255.0), 0.0, 1.0), 1.0);
    }
  `;

  class GrainRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ok = false;
      this.error = '';
      const opts = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      };
      this.gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
      if (!this.gl) {
        this.error = 'WebGL is not available in this browser.';
        return;
      }
      this.init();
    }

    compile(type, source) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        this.error = gl.getShaderInfoLog(sh) || 'Shader compile failed.';
        console.error(this.error);
        return null;
      }
      return sh;
    }

    init() {
      const gl = this.gl;
      const vs = this.compile(gl.VERTEX_SHADER, VERT);
      const fs = this.compile(gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return;

      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        this.error = gl.getProgramInfoLog(p) || 'Program link failed.';
        console.error(this.error);
        return;
      }
      this.program = p;
      gl.useProgram(p);

      this.aPos = gl.getAttribLocation(p, 'a_pos');
      this.u = {
        image: gl.getUniformLocation(p, 'u_image'),
        seed: gl.getUniformLocation(p, 'u_seed'),
        gain: gl.getUniformLocation(p, 'u_gain'),
        dist: gl.getUniformLocation(p, 'u_dist'),
        radius: gl.getUniformLocation(p, 'u_radius'),
        k1: gl.getUniformLocation(p, 'u_k1'),
        k2: gl.getUniformLocation(p, 'u_k2'),
        tone: gl.getUniformLocation(p, 'u_tone'),
      };

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      this.ok = true;
    }

    maxTextureSize() {
      if (!this.gl) return 4096;
      return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) || 4096;
    }

    setImage(src) {
      if (!this.ok) return;
      const gl = this.gl;
      const max = this.maxTextureSize();
      if (src.width > max || src.height > max) {
        throw new Error(`Texture limit is ${max}px.`);
      }
      this.canvas.width = src.width;
      this.canvas.height = src.height;
      gl.viewport(0, 0, src.width, src.height);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.hasImage = true;
    }

    render(p) {
      if (!this.ok || !this.hasImage) return;
      const gl = this.gl;
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.u.image, 0);
      gl.uniform1f(this.u.seed, p.seed);
      gl.uniform1f(this.u.gain, p.gain);
      gl.uniform1f(this.u.dist, p.dist);
      gl.uniform1f(this.u.radius, p.radius);
      gl.uniform1f(this.u.k1, p.k1);
      gl.uniform1f(this.u.k2, p.k2);
      gl.uniform1f(this.u.tone, p.tone ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // ------------------------------------------------------------------ image

  async function decodeFile(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { bitmap, w: bitmap.width, h: bitmap.height };
      } catch (_) { /* fall through to <img> */ }
    }
    return await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ bitmap: img, w: img.naturalWidth, h: img.naturalHeight, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('decode'));
      };
      img.src = url;
    });
  }

  function workSize(w, h) {
    const maxGL = renderer ? renderer.maxTextureSize() : 4096;
    let edge = state.maxEdge > 0 ? state.maxEdge : Math.max(w, h);
    edge = Math.min(edge, maxGL, 8192);
    const scale = Math.min(1, edge / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  function sourceSize() {
    const rotation = source.rotation || 0;
    return rotation % 180 === 0
      ? { w: source.w, h: source.h }
      : { w: source.h, h: source.w };
  }

  function prepare() {
    const size = sourceSize();
    const { w, h } = workSize(size.w, size.h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scale = Math.min(w / size.w, h / size.h);
    const dw = source.w * scale;
    const dh = source.h * scale;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(((source.rotation || 0) * Math.PI) / 180);
    ctx.drawImage(source.bitmap, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();

    work = { canvas, w, h };

    els.original.width = w;
    els.original.height = h;
    const octx = els.original.getContext('2d');
    if (octx) octx.drawImage(canvas, 0, 0);

    renderer.setImage(canvas);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!renderer || !renderer.ok) {
      showToast(renderer ? renderer.error : 'WebGL is not available.');
      return;
    }
    setBusy(true);
    closeSheets();
    try {
      const next = await decodeFile(file);
      if (source && source.url) URL.revokeObjectURL(source.url);
      if (source && source.bitmap && source.bitmap.close) source.bitmap.close();
      source = { ...next, rotation: 0 };

      try {
        prepare();
      } catch (err) {
        if (state.maxEdge === 0 || state.maxEdge > 4096) {
          showToast('Image too large; retrying at 4096 px…');
          const old = state.maxEdge;
          state.maxEdge = 4096;
          saveSettings();
          syncUI();
          try { prepare(); } catch (_) { state.maxEdge = old; saveSettings(); syncUI(); throw err; }
        } else {
          throw err;
        }
      }

      document.body.classList.add('has-image');
      els.canvasWrap.hidden = false;
      els.empty.hidden = true;
      els.compareBtn.disabled = false;
      els.rotateBtn.disabled = false;
      els.saveBtn.disabled = false;
      showOriginal(false);
      render();
      updateStatus();
      requestAnimationFrame(resetView);
    } catch (err) {
      console.error(err);
      const msg = err && err.message === 'decode'
        ? 'Could not read that image. Try a JPEG export.'
        : (err && err.message) || 'Could not process that image.';
      showToast(msg);
    } finally {
      setBusy(false);
    }
  }

  function render() {
    if (!work || !source) return;
    if (!renderer || !renderer.ok) {
      showToast(renderer ? renderer.error : 'WebGL is not available.');
      return;
    }
    const p = modelParams(state.size, state.strength, state.film);
    renderer.render({
      seed: state.seed,
      gain: computeGain(state.size, state.strength, state.amount, state.film),
      dist: p.dist,
      radius: p.radius,
      k1: p.k1,
      k2: p.k2,
      tone: state.tone,
    });
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 60);
  }

  function showOriginal(on) {
    if (!work) return;
    els.original.hidden = !on;
    els.compareBtn.classList.toggle('active', on);
    els.compareBtn.setAttribute('aria-pressed', String(on));
    els.compareBtn.title = on ? 'Show grain' : 'Show original';
  }

  function rotateImage() {
    if (!source || !work) return;
    source.rotation = ((source.rotation || 0) + 90) % 360;
    setBusy(true);
    try {
      prepare();
      render();
      updateStatus();
      showOriginal(false);
      requestAnimationFrame(resetView);
    } catch (err) {
      console.error(err);
      showToast('Could not rotate the image.');
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ camera

  function isIOSDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function stopCameraStream() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    if (els.cameraVideo) {
      els.cameraVideo.pause();
      els.cameraVideo.srcObject = null;
      els.cameraVideo.classList.remove('front');
    }
  }

  function cameraErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera access is blocked. Allow camera access for this site in Settings, or use Photos.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      if (cameraFacing === 'user') {
        cameraFacing = 'environment';
        return 'The front camera is unavailable. Try again to use the rear camera, or use Photos.';
      }
      return 'No camera was found on this device. Use Photos instead.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is already in use by another app. Close that app and try again.';
    }
    if (name === 'OverconstrainedError') {
      if (cameraFacing === 'user') cameraFacing = 'environment';
      return 'This camera does not support the requested mode. Try again, or use Photos.';
    }
    return 'Could not start the camera. Use the phone camera or Photos instead.';
  }

  function showCameraError(err) {
    els.cameraErrorText.textContent = cameraErrorMessage(err);
    els.cameraError.hidden = false;
    els.cameraStatus.textContent = 'Camera unavailable';
  }

  async function getCameraStream(facing) {
    const md = navigator.mediaDevices;
    const base = { audio: false, video: { facingMode: { ideal: facing } } };
    const high = {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
    };
    try {
      return await md.getUserMedia(high);
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError' ||
                  err.name === 'TypeError')) {
        return await md.getUserMedia(base);
      }
      throw err;
    }
  }

  async function openCamera() {
    closeSheets();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      els.cameraInput.click();
      return;
    }
    if (cameraStarting) return;

    const request = ++cameraRequest;
    cameraStarting = true;
    cameraActive = true;
    els.cameraView.hidden = false;
    document.body.classList.add('camera-open');
    els.cameraError.hidden = true;
    els.cameraLoading.hidden = false;
    els.cameraStatus.textContent = 'Starting camera…';
    els.cameraShutter.disabled = true;
    stopCameraStream();

    try {
      const stream = await getCameraStream(cameraFacing);
      if (!cameraActive || request !== cameraRequest) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream = stream;
      els.cameraVideo.srcObject = stream;
      els.cameraVideo.classList.toggle('front', cameraFacing === 'user');
      await els.cameraVideo.play();

      if (!els.cameraVideo.videoWidth) {
        await new Promise((resolve) => {
          const done = () => {
            els.cameraVideo.removeEventListener('loadedmetadata', done);
            resolve();
          };
          els.cameraVideo.addEventListener('loadedmetadata', done);
          setTimeout(done, 1500);
        });
      }

      const vw = els.cameraVideo.videoWidth;
      const vh = els.cameraVideo.videoHeight;
      els.cameraStatus.textContent = vw && vh ? `Live · ${vw} × ${vh}` : 'Live camera';
      els.cameraLoading.hidden = true;
      els.cameraShutter.disabled = false;
    } catch (err) {
      if (!cameraActive || request !== cameraRequest) return;
      console.error(err);
      els.cameraLoading.hidden = true;
      els.cameraShutter.disabled = true;
      showCameraError(err);
    } finally {
      cameraStarting = false;
    }
  }

  function closeCamera() {
    cameraActive = false;
    cameraStarting = false;
    cameraRequest++;
    stopCameraStream();
    els.cameraView.hidden = true;
    document.body.classList.remove('camera-open');
    els.cameraError.hidden = true;
    els.cameraLoading.hidden = true;
    els.cameraShutter.disabled = true;
    els.cameraStatus.textContent = 'Camera';
  }

  async function flipCamera() {
    if (cameraStarting) return;
    cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
    await openCamera();
  }

  function captureRotation(vw, vh) {
    if (vw <= vh) return 0;
    if (!isIOSDevice()) return 0;

    const raw = typeof window.orientation === 'number'
      ? window.orientation
      : (screen.orientation && typeof screen.orientation.angle === 'number'
        ? screen.orientation.angle
        : 0);
    const angle = ((raw % 360) + 360) % 360;
    if (angle === 90 || angle === 270) return 0;
    return angle === 180 ? 270 : 90;
  }

  async function captureFrame() {
    const video = els.cameraVideo;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const rotation = captureRotation(vw, vh);
    const swap = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? vh : vw;
    canvas.height = swap ? vw : vh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.save();
    if (rotation === 90) {
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      ctx.translate(canvas.width, canvas.height);
      ctx.rotate(Math.PI);
    } else if (rotation === 270) {
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    }
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.restore();

    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  }

  async function capturePhoto() {
    if (!cameraActive || !cameraStream || els.cameraShutter.disabled) return;
    els.cameraShutter.disabled = true;
    els.cameraLoading.hidden = false;
    els.cameraStatus.textContent = 'Capturing…';

    try {
      let blob = null;
      const track = cameraStream.getVideoTracks()[0];
      if (window.ImageCapture && typeof window.ImageCapture === 'function' && track) {
        try {
          const capture = new window.ImageCapture(track);
          if (typeof capture.takePhoto === 'function') blob = await capture.takePhoto();
        } catch (err) {
          console.warn('ImageCapture failed; using the video frame.', err);
        }
      }
      if (!blob) blob = await captureFrame();
      if (!blob) throw new Error('capture');

      const type = blob.type || 'image/jpeg';
      const ext = type.includes('png') ? 'png' : 'jpg';
      const file = new File([blob], `camera-${Date.now()}.${ext}`, { type });
      closeCamera();
      await handleFile(file);
    } catch (err) {
      console.error(err);
      els.cameraLoading.hidden = true;
      els.cameraShutter.disabled = false;
      els.cameraStatus.textContent = 'Capture failed · try again';
    }
  }

  function cameraToGallery() {
    closeCamera();
    els.galleryInput.click();
  }

  function cameraToNative() {
    closeCamera();
    els.cameraInput.click();
  }

  // -------------------------------------------------------------------- UI

  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    els.busy.hidden = busyCount === 0;
  }

  function showToast(text, ms = 2600) {
    clearTimeout(toastTimer);
    els.toast.textContent = text;
    els.toast.hidden = false;
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function updateStatus() {
    if (!els.info) return;
    if (!work || !source) {
      els.info.textContent = '';
      return;
    }
    const size = sourceSize();
    const dims = (work.w === size.w && work.h === size.h)
      ? `${work.w} × ${work.h}`
      : `${size.w} × ${size.h} → ${work.w} × ${work.h}`;
    els.info.textContent = `${dims} · ${modelLabel()}`;
  }

  function syncUI() {
    document.querySelectorAll('[data-size]').forEach((b) => {
      const on = b.dataset.size === state.size;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-strength]').forEach((b) => {
      const on = b.dataset.strength === state.strength;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-film]').forEach((b) => {
      const on = b.dataset.film === state.film;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-format]').forEach((b) => {
      const on = b.dataset.format === state.format;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    els.amount.value = String(state.amount);
    els.amountOut.textContent = `${state.amount}%`;
    els.barAmount.textContent = `${state.amount}%`;
    els.sizeValue.textContent = state.size === 'small' ? 'Small' : 'Large';
    els.strengthValue.textContent = state.strength === 'weak' ? 'Weak' : 'Strong';
    els.filmValue.textContent = state.film === 'acros' ? 'Acros' : 'Color';
    els.seedOut.textContent = String(state.seed);
    els.tone.checked = state.tone;
    els.resolution.value = String(state.maxEdge);
    updateStatus();
  }

  function closeSheets() {
    document.querySelectorAll('.control-sheet').forEach((sheet) => { sheet.hidden = true; });
    document.querySelectorAll('[data-open-sheet]').forEach((btn) => btn.classList.remove('active'));
  }

  function toggleSheet(name, button) {
    const sheet = document.querySelector(`.control-sheet[data-sheet="${name}"]`);
    if (!sheet) return;
    const wasHidden = sheet.hidden;
    closeSheets();
    if (wasHidden) {
      sheet.hidden = false;
      button.classList.add('active');
    }
  }

  function resetView() {
    viewState.scale = 1;
    viewState.x = 0;
    viewState.y = 0;
    applyView();
  }

  function applyView() {
    els.canvasWrap.style.transform =
      `translate3d(${viewState.x}px, ${viewState.y}px, 0) scale(${viewState.scale})`;
    const zoomed = viewState.scale > 1.01;
    els.zoomLabel.hidden = !zoomed;
    if (zoomed) els.zoomLabel.textContent = `${viewState.scale.toFixed(1)}×`;
  }

  function clampView() {
    if (!work) return;
    const vw = els.frame.clientWidth;
    const vh = els.frame.clientHeight;
    const bw = els.canvasWrap.offsetWidth;
    const bh = els.canvasWrap.offsetHeight;
    const maxX = Math.max(0, (bw * viewState.scale - vw) / 2);
    const maxY = Math.max(0, (bh * viewState.scale - vh) / 2);
    viewState.x = Math.max(-maxX, Math.min(maxX, viewState.x));
    viewState.y = Math.max(-maxY, Math.min(maxY, viewState.y));
  }

  function bindViewer() {
    const frame = els.frame;
    const pointers = new Map();
    let dragStart = null;
    let pinchStart = null;
    let lastTap = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const centerPoint = (clientX, clientY) => {
      const rect = frame.getBoundingClientRect();
      return {
        x: clientX - rect.left - rect.width / 2,
        y: clientY - rect.top - rect.height / 2,
      };
    };

    const zoomAt = (clientX, clientY, factor) => {
      const p = centerPoint(clientX, clientY);
      const next = Math.max(1, Math.min(8, viewState.scale * factor));
      const k = next / viewState.scale;
      viewState.x = p.x - k * (p.x - viewState.x);
      viewState.y = p.y - k * (p.y - viewState.y);
      viewState.scale = next;
      clampView();
      applyView();
    };

    const toggleZoom = (clientX, clientY) => {
      if (viewState.scale > 1.01) {
        resetView();
        return;
      }
      const p = centerPoint(clientX, clientY);
      const next = 2.5;
      viewState.scale = next;
      viewState.x = p.x - next * p.x;
      viewState.y = p.y - next * p.y;
      clampView();
      applyView();
    };

    frame.addEventListener('pointerdown', (e) => {
      if (!work || e.target.closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      frame.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1) {
        dragStart = { x: e.clientX, y: e.clientY, vx: viewState.x, vy: viewState.y };
        const now = performance.now();
        if (now - lastTap < 320 &&
            Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 28) {
          toggleZoom(e.clientX, e.clientY);
          dragStart = null;
          lastTap = 0;
        } else {
          lastTap = now;
          lastTapX = e.clientX;
          lastTapY = e.clientY;
        }
      } else if (pointers.size === 2) {
        const pts = [...pointers.values()];
        pinchStart = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
          scale: viewState.scale,
          x: viewState.x,
          y: viewState.y,
        };
        dragStart = null;
      }
    });

    frame.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1 && dragStart) {
        viewState.x = dragStart.vx + (e.clientX - dragStart.x);
        viewState.y = dragStart.vy + (e.clientY - dragStart.y);
        clampView();
        applyView();
      } else if (pointers.size === 2 && pinchStart) {
        const pts = [...pointers.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const ratio = pinchStart.dist > 0 ? dist / pinchStart.dist : 1;
        const next = Math.max(1, Math.min(8, pinchStart.scale * ratio));
        const k = next / pinchStart.scale;
        const startMid = centerPoint(pinchStart.mid.x, pinchStart.mid.y);
        const nowMid = centerPoint(mid.x, mid.y);
        viewState.scale = next;
        viewState.x = nowMid.x - k * (startMid.x - pinchStart.x);
        viewState.y = nowMid.y - k * (startMid.y - pinchStart.y);
        clampView();
        applyView();
      }
    });

    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) dragStart = null;
    };
    frame.addEventListener('pointerup', endPointer);
    frame.addEventListener('pointercancel', endPointer);

    frame.addEventListener('wheel', (e) => {
      if (!work) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (!work) return;
      clampView();
      applyView();
    });
  }

  function bind() {
    document.querySelectorAll('[data-size]').forEach((b) => {
      b.addEventListener('click', () => {
        state.size = b.dataset.size;
        saveSettings();
        syncUI();
        scheduleRender();
      });
    });
    document.querySelectorAll('[data-strength]').forEach((b) => {
      b.addEventListener('click', () => {
        state.strength = b.dataset.strength;
        saveSettings();
        syncUI();
        scheduleRender();
      });
    });
    document.querySelectorAll('[data-film]').forEach((b) => {
      b.addEventListener('click', () => {
        state.film = b.dataset.film;
        saveSettings();
        syncUI();
        scheduleRender();
      });
    });
    document.querySelectorAll('[data-format]').forEach((b) => {
      b.addEventListener('click', () => {
        state.format = b.dataset.format;
        saveSettings();
        syncUI();
      });
    });

    els.amount.addEventListener('input', () => {
      state.amount = Math.max(0, Math.min(200, Number(els.amount.value) || 0));
      els.amountOut.textContent = `${state.amount}%`;
      els.barAmount.textContent = `${state.amount}%`;
      saveSettings();
      scheduleRender();
    });

    els.shuffleBtn.addEventListener('click', () => {
      state.seed = Math.floor(Math.random() * 4096);
      saveSettings();
      syncUI();
      render();
    });

    els.tone.addEventListener('change', () => {
      state.tone = els.tone.checked;
      saveSettings();
      scheduleRender();
    });

    els.resolution.addEventListener('change', () => {
      state.maxEdge = Number(els.resolution.value);
      saveSettings();
      if (source) {
        setBusy(true);
        try {
          prepare();
          render();
          updateStatus();
          closeSheets();
          requestAnimationFrame(resetView);
        } catch (err) {
          console.error(err);
          showToast('Could not resize; try 4096 px.');
        } finally {
          setBusy(false);
        }
      }
    });

    els.resetBtn.addEventListener('click', () => {
      state = { ...DEFAULTS };
      saveSettings();
      syncUI();
      render();
      closeSheets();
      requestAnimationFrame(resetView);
    });

    els.takeBtn.addEventListener('click', openCamera);
    els.chooseBtn.addEventListener('click', () => els.galleryInput.click());
    els.emptyCamera.addEventListener('click', openCamera);
    els.emptyPhotos.addEventListener('click', () => els.galleryInput.click());

    const onPick = (input) => {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (file) handleFile(file);
      });
    };
    onPick(els.cameraInput);
    onPick(els.galleryInput);

    document.querySelectorAll('[data-open-sheet]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSheet(btn.dataset.openSheet, btn);
      });
    });

    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.control-sheet') || e.target.closest('[data-open-sheet]')) return;
      closeSheets();
    });

    els.cameraClose.addEventListener('click', closeCamera);
    els.cameraShutter.addEventListener('click', capturePhoto);
    els.cameraFlip.addEventListener('click', flipCamera);
    els.cameraPhotos.addEventListener('click', cameraToGallery);
    els.cameraRetry.addEventListener('click', openCamera);
    els.cameraFallback.addEventListener('click', cameraToNative);
    els.cameraErrorPhotos.addEventListener('click', cameraToGallery);
    els.cameraErrorClose.addEventListener('click', closeCamera);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.control-sheet:not([hidden])')) {
        closeSheets();
      } else if (cameraActive) {
        closeCamera();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && cameraActive && !cameraStarting) closeCamera();
    });
    window.addEventListener('pagehide', () => {
      if (cameraActive) closeCamera();
    });

    els.compareBtn.addEventListener('click', () => showOriginal(els.original.hidden));
    els.fitBtn.addEventListener('click', resetView);
    els.rotateBtn.addEventListener('click', () => {
      rotateImage();
      closeSheets();
    });
    els.saveBtn.addEventListener('click', saveImage);

    // Desktop drag and drop.
    els.frame.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.frame.classList.add('dragover');
    });
    els.frame.addEventListener('dragleave', () => els.frame.classList.remove('dragover'));
    els.frame.addEventListener('drop', (e) => {
      e.preventDefault();
      els.frame.classList.remove('dragover');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) handleFile(file);
    });
  }

  async function saveImage() {
    if (!work || !renderer || !renderer.ok) return;
    const png = state.format === 'png';
    const type = png ? 'image/png' : 'image/jpeg';
    const ext = png ? 'png' : 'jpg';
    setBusy(true);
    try {
      const blob = await new Promise((resolve) => renderer.canvas.toBlob(resolve, type, 0.95));
      if (!blob) throw new Error('encode');
      const name = `grain-${state.size}-${state.strength}-${Date.now()}.${ext}`;
      const file = new File([blob], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: 'Grain' });
          showToast(`Shared ${ext.toUpperCase()}`);
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(`Saved ${ext.toUpperCase()}`);
    } catch (err) {
      console.error(err);
      showToast('Could not save the image.');
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------- PWA

  function initPWA() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(() => { /* offline is optional */ });
      });
    }

    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      els.installRow.hidden = false;
      els.installBtn.hidden = false;
    });
    els.installBtn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) { /* ignore */ }
      deferred = null;
      els.installRow.hidden = true;
      els.installBtn.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      els.installRow.hidden = true;
      els.installBtn.hidden = true;
    });

    const isIOS = isIOSDevice();
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;
    if (isIOS && !standalone) els.iosHint.hidden = false;
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    renderer = new GrainRenderer(els.view);
    if (!renderer.ok) {
      showToast(renderer.error || 'WebGL is not available.');
      els.empty.querySelector('strong').textContent = 'WebGL required';
      els.empty.querySelector('span').textContent =
        'This browser cannot run the grain renderer. Try Safari, Chrome, or Firefox on a recent device.';
    }
    bind();
    bindViewer();
    syncUI();
    saveSettings();
    initPWA();
  }

  boot();
})();
