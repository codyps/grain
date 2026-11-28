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
    model: 'xt4',
    size: 'large',
    strength: 'strong',
    film: 'color',
    amount: 100,
    seed: 517,
    tone: true,
    maxEdge: 0,
    format: 'jpeg',
    physicsGrain: 6,
    physicsLayers: 120,
    physicsLayers2: 20,
    physicsTier: 2,
    physicsColor: 'color',
    physicsRho: 0.7,
    physicsChroma: 0.4,
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
    cameraLens: $('cameraLens'),
    cameraLensLabel: $('cameraLensLabel'),
    cameraLensClose: $('cameraLensClose'),
    cameraLensSheet: $('cameraLensSheet'),
    cameraLensList: $('cameraLensList'),
    cameraZoomBar: $('cameraZoomBar'),
    cameraZoomPresets: $('cameraZoomPresets'),
    cameraFlash: $('cameraFlash'),
    cameraShutter: $('cameraShutter'),
    cameraPhotos: $('cameraPhotos'),
    cameraStatus: $('cameraStatus'),
    cameraLoading: $('cameraLoading'),
    cameraLoadingText: $('cameraLoadingText'),
    cameraError: $('cameraError'),
    cameraErrorText: $('cameraErrorText'),
    cameraRetry: $('cameraRetry'),
    cameraFallback: $('cameraFallback'),
    cameraErrorPhotos: $('cameraErrorPhotos'),
    cameraErrorClose: $('cameraErrorClose'),
    amount: $('amount'),
    amountOut: $('amountOut'),
    barAmount: $('barAmount'),
    sizeLabel: $('sizeLabel'),
    strengthLabel: $('strengthLabel'),
    filmLabel: $('filmLabel'),
    sizeValue: $('sizeValue'),
    strengthValue: $('strengthValue'),
    filmValue: $('filmValue'),
    modelHint: $('modelHint'),
    physicsGrain: $('physicsGrain'),
    physicsGrainOut: $('physicsGrainOut'),
    physicsLayers: $('physicsLayers'),
    physicsLayersOut: $('physicsLayersOut'),
    layersHint: $('layersHint'),
    tierHint: $('tierHint'),
    physicsRho: $('physicsRho'),
    physicsRhoOut: $('physicsRhoOut'),
    physicsChroma: $('physicsChroma'),
    physicsChromaOut: $('physicsChromaOut'),
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
  let tier2Busy = false;
  let tier2Again = false;
  let cameraStream = null;
  let cameraFacing = 'environment';
  let cameraActive = false;
  let cameraStarting = false;
  let cameraRequest = 0;
  let cameraDeviceId = null;
  let cameraDevices = [];
  let cameraZoom = 1;
  let cameraZoomCap = null;
  let cameraDigitalZoom = false;
  let cameraDimensions = { w: 0, h: 0 };
  let cameraZoomRaf = 0;
  const cameraPointers = new Map();
  let cameraPinchStart = null;
  const viewState = { scale: 1, x: 0, y: 0 };

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    const s = { ...DEFAULTS };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.model === 'xt4' || raw.model === 'physics') s.model = raw.model;
      if (raw.size === 'small' || raw.size === 'large') s.size = raw.size;
      if (raw.strength === 'weak' || raw.strength === 'strong') s.strength = raw.strength;
      if (raw.film === 'color' || raw.film === 'acros') s.film = raw.film;
      if (raw.physicsColor === 'color' || raw.physicsColor === 'mono') s.physicsColor = raw.physicsColor;
      if (Number.isFinite(raw.physicsGrain)) s.physicsGrain = Math.max(2, Math.min(16, Math.round(raw.physicsGrain)));
      if (Number.isFinite(raw.physicsLayers)) s.physicsLayers = Math.max(4, Math.min(160, Math.round(raw.physicsLayers)));
      if (Number.isFinite(raw.physicsLayers2)) s.physicsLayers2 = Math.max(4, Math.min(40, Math.round(raw.physicsLayers2)));
      if (raw.physicsTier === 1 || raw.physicsTier === 2) s.physicsTier = raw.physicsTier;
      if (Number.isFinite(raw.physicsRho)) s.physicsRho = Math.max(0, Math.min(0.95, raw.physicsRho));
      if (Number.isFinite(raw.physicsChroma)) s.physicsChroma = Math.max(0, Math.min(1, raw.physicsChroma));
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
    if (state.model === 'physics') {
      const layers = state.physicsTier === 2 ? state.physicsLayers2 : state.physicsLayers;
      return `Tier ${state.physicsTier} · Grain ${state.physicsGrain}px · ${layers} layers · ` +
        `${state.physicsColor === 'mono' ? 'Mono' : 'Color'} · ${state.amount}%`;
    }
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

  // Physics tier: density-dependent coverage statistics from the layered
  // Poisson model. A correlated Gaussian field is generated once per settings
  // change, then modulated by sqrt(p(1-p)/layers) in the composite.
  const NOISE_GLSL = `
    float hash(vec2 p, float seed) {
      float s = mod(seed, 4096.0);
      p += vec2(s * 0.137, s * 0.271);
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float gauss(vec2 p, float seed) {
      float u1 = max(hash(p, seed), 1e-6);
      float u2 = hash(p + vec2(37.0, 17.0), seed + 1.0);
      return sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2);
    }
  `;

  const PHYS_NOISE_H = `
    precision highp float;
    uniform float u_seed;
    uniform float u_step;
    uniform float u_encode;
    ${NOISE_GLSL}
    void main() {
      vec2 base = gl_FragCoord.xy;
      vec4 sum = vec4(0.0);
      for (int i = -3; i <= 3; i++) {
        float d = abs(float(i));
        float w = d < 0.5 ? 0.29607 : (d < 1.5 ? 0.21212 : (d < 2.5 ? 0.07461 : 0.06523));
        vec2 p = base + vec2(float(i) * u_step, 0.0);
        sum.r += gauss(p, u_seed) * w;
        sum.g += gauss(p, u_seed + 17.0) * w;
        sum.b += gauss(p, u_seed + 34.0) * w;
        sum.a += gauss(p, u_seed + 51.0) * w;
      }
      gl_FragColor = vec4(clamp(0.5 + sum * u_encode, 0.0, 1.0));
    }
  `;

  const PHYS_NOISE_V = `
    precision highp float;
    uniform sampler2D u_texA;
    uniform vec2 u_texSize;
    uniform float u_step;
    uniform float u_rho;
    uniform float u_encode;
    uniform float u_norm;
    varying vec2 v_uv;
    void main() {
      vec4 sum = vec4(0.0);
      for (int i = -3; i <= 3; i++) {
        float d = abs(float(i));
        float w = d < 0.5 ? 0.29607 : (d < 1.5 ? 0.21212 : (d < 2.5 ? 0.07461 : 0.06523));
        vec2 uv = v_uv + vec2(0.0, float(i) * u_step / u_texSize.y);
        vec4 g = (texture2D(u_texA, uv) - 0.5) / u_encode;
        sum += g * w;
      }
      sum *= u_norm;
      float a = sqrt(u_rho);
      float b = sqrt(max(0.0, 1.0 - u_rho));
      vec3 mixed = a * vec3(sum.a) + b * sum.rgb;
      gl_FragColor = vec4(clamp(0.5 + mixed / 6.0, 0.0, 1.0), 1.0);
    }
  `;

  const PHYS_FRAG = `
    precision highp float;
    uniform sampler2D u_image;
    uniform sampler2D u_noise;
    uniform float u_gain;
    uniform float u_mono;
    uniform float u_chroma;
    varying vec2 v_uv;

    vec3 srgbToLinear(vec3 c) {
      vec3 lo = c / 12.92;
      vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
      return mix(hi, lo, 1.0 - step(vec3(0.04045), c));
    }

    vec3 linearToSrgb(vec3 c) {
      vec3 lo = c * 12.92;
      vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
      return mix(hi, lo, 1.0 - step(vec3(0.0031308), c));
    }

    void main() {
      vec3 c = texture2D(u_image, v_uv).rgb;
      vec3 lin = srgbToLinear(clamp(c, 0.0, 1.0));
      vec3 n = texture2D(u_noise, v_uv).rgb;
      vec3 g = (n - 0.5) * 6.0;

      if (u_mono > 0.5) {
        float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
        float p = 1.0 - y;
        float amp = sqrt(max(p * (1.0 - p), 0.0));
        float d = g.r * amp * u_gain;
        float yOut = y + d;
        lin *= yOut / max(y, 1e-4);
      } else {
        vec3 p = 1.0 - lin;
        vec3 amp = sqrt(max(p * (1.0 - p), vec3(0.0)));
        vec3 dev = g * amp * u_gain;
        float yDev = dot(dev, vec3(0.2126, 0.7152, 0.0722));
        dev = yDev + u_chroma * (dev - yDev);
        lin += dev;
      }

      gl_FragColor = vec4(linearToSrgb(clamp(lin, 0.0, 1.0)), 1.0);
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

    makeProgram(fsSource) {
      const gl = this.gl;
      const vs = this.compile(gl.VERTEX_SHADER, VERT);
      const fs = this.compile(gl.FRAGMENT_SHADER, fsSource);
      if (!vs || !fs) return null;
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        this.error = gl.getProgramInfoLog(program) || 'Program link failed.';
        console.error(this.error);
        return null;
      }
      return program;
    }

    bindQuad(program) {
      const gl = this.gl;
      const loc = gl.getAttribLocation(program, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    init() {
      const gl = this.gl;
      this.program = this.makeProgram(FRAG);
      if (!this.program) return;

      this.u = {
        image: gl.getUniformLocation(this.program, 'u_image'),
        seed: gl.getUniformLocation(this.program, 'u_seed'),
        gain: gl.getUniformLocation(this.program, 'u_gain'),
        dist: gl.getUniformLocation(this.program, 'u_dist'),
        radius: gl.getUniformLocation(this.program, 'u_radius'),
        k1: gl.getUniformLocation(this.program, 'u_k1'),
        k2: gl.getUniformLocation(this.program, 'u_k2'),
        tone: gl.getUniformLocation(this.program, 'u_tone'),
      };

      this.physicsOk = false;
      this.physHProgram = this.makeProgram(PHYS_NOISE_H);
      this.physVProgram = this.makeProgram(PHYS_NOISE_V);
      this.physProgram = this.makeProgram(PHYS_FRAG);
      if (this.physHProgram && this.physVProgram && this.physProgram) {
        this.physicsOk = true;
        this.physHU = {
          seed: gl.getUniformLocation(this.physHProgram, 'u_seed'),
          step: gl.getUniformLocation(this.physHProgram, 'u_step'),
          encode: gl.getUniformLocation(this.physHProgram, 'u_encode'),
        };
        this.physVU = {
          texA: gl.getUniformLocation(this.physVProgram, 'u_texA'),
          texSize: gl.getUniformLocation(this.physVProgram, 'u_texSize'),
          step: gl.getUniformLocation(this.physVProgram, 'u_step'),
          rho: gl.getUniformLocation(this.physVProgram, 'u_rho'),
          encode: gl.getUniformLocation(this.physVProgram, 'u_encode'),
          norm: gl.getUniformLocation(this.physVProgram, 'u_norm'),
        };
        this.physU = {
          image: gl.getUniformLocation(this.physProgram, 'u_image'),
          noise: gl.getUniformLocation(this.physProgram, 'u_noise'),
          gain: gl.getUniformLocation(this.physProgram, 'u_gain'),
          mono: gl.getUniformLocation(this.physProgram, 'u_mono'),
          chroma: gl.getUniformLocation(this.physProgram, 'u_chroma'),
        };
      } else {
        console.warn('Physics grain shaders unavailable; using the X-T4 model only.');
      }

      this.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.bindQuad(this.program);

      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      this.physSig = '';
      this.physA = null;
      this.physB = null;
      this.tier2 = window.Tier2Renderer
        ? new window.Tier2Renderer(gl, this.tex, this.canvas, this.maxTextureSize())
        : null;
      this.tier2Ok = !!(this.tier2 && this.tier2.ok);
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
      this.physSig = '';
      if (this.tier2) this.tier2.invalidate();
    }

    createPhysicsTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Physics render target incomplete:', status);
        gl.deleteTexture(tex);
        gl.deleteFramebuffer(fbo);
        return null;
      }
      return { tex, fbo, w, h };
    }

    deletePhysicsTargets() {
      const gl = this.gl;
      [this.physA, this.physB].forEach((target) => {
        if (!target) return;
        gl.deleteTexture(target.tex);
        gl.deleteFramebuffer(target.fbo);
      });
      this.physA = null;
      this.physB = null;
      this.physSig = '';
    }

    ensurePhysicsTargets(w, h) {
      if (this.physA && this.physA.w === w && this.physA.h === h &&
          this.physB && this.physB.w === w && this.physB.h === h) {
        return true;
      }
      this.deletePhysicsTargets();
      this.physA = this.createPhysicsTarget(w, h);
      this.physB = this.createPhysicsTarget(w, h);
      if (!this.physA || !this.physB) {
        this.deletePhysicsTargets();
        this.physicsOk = false;
        return false;
      }
      return true;
    }

    generatePhysicsNoise(w, h, step, seed, rho) {
      const gl = this.gl;

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.physA.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.physHProgram);
      this.bindQuad(this.physHProgram);
      gl.uniform1f(this.physHU.seed, seed);
      gl.uniform1f(this.physHU.step, step);
      gl.uniform1f(this.physHU.encode, 0.3752);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.physB.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.physVProgram);
      this.bindQuad(this.physVProgram);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.physA.tex);
      gl.uniform1i(this.physVU.texA, 2);
      gl.uniform2f(this.physVU.texSize, w, h);
      gl.uniform1f(this.physVU.step, step);
      gl.uniform1f(this.physVU.rho, rho);
      gl.uniform1f(this.physVU.encode, 0.3752);
      gl.uniform1f(this.physVU.norm, 1.0 / 0.197294);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    render(p) {
      if (!this.ok || !this.hasImage) return false;
      if (p.model === 'physics' && p.tier === 2) {
        return this.tier2Ok ? this.tier2.render(p) : false;
      }
      if (p.model === 'physics' && this.physicsOk) return this.renderPhysics(p);
      return this.renderXt4(p);
    }

    renderXt4(p) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.program);
      this.bindQuad(this.program);
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
      return true;
    }

    renderPhysics(p) {
      if (!this.physicsOk) return false;
      const gl = this.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const maxEdge = Math.min(3072, this.maxTextureSize());
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const texW = Math.max(1, Math.round(w * scale));
      const texH = Math.max(1, Math.round(h * scale));
      const step = Math.max(0.02, Math.min(8, (p.grainPx / 6) * (texW / w)));
      const rho = Number.isFinite(p.rho) ? p.rho : 0.8;
      const sig = `${texW}x${texH}|${p.seed}|${rho.toFixed(3)}|${step.toFixed(4)}`;
      if (!this.ensurePhysicsTargets(texW, texH)) return false;
      if (sig !== this.physSig) {
        this.generatePhysicsNoise(texW, texH, step, p.seed, rho);
        this.physSig = sig;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.physProgram);
      this.bindQuad(this.physProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(this.physU.image, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.physB.tex);
      gl.uniform1i(this.physU.noise, 1);
      gl.uniform1f(this.physU.gain,
        (p.amount / 100) * 0.8 / Math.sqrt(Math.max(1, p.layers)));
      gl.uniform1f(this.physU.mono, p.mono ? 1 : 0);
      gl.uniform1f(this.physU.chroma, p.chroma);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return true;
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

    if (state.model === 'physics') {
      if (state.physicsTier === 2) {
        if (!renderer.tier2Ok) {
          state.physicsTier = 1;
          saveSettings();
          syncUI();
          showToast('Tier 2 is unavailable; using Preview.');
        } else if (tier2Busy) {
          tier2Again = true;
          return;
        } else {
          tier2Busy = true;
          els.saveBtn.disabled = true;
          setBusy(true);
          showToast('Rendering Tier-2…', 1200);
          requestAnimationFrame(() => setTimeout(() => {
            let ok = false;
            try {
              ok = renderer.render({
                model: 'physics',
                tier: 2,
                seed: state.seed,
                grainPx: state.physicsGrain,
                layers: state.physicsLayers2,
                mono: state.physicsColor === 'mono',
                rho: state.physicsRho,
                chroma: state.physicsChroma,
                amount: state.amount,
              });
            } catch (err) {
              console.error(err);
            } finally {
              tier2Busy = false;
              setBusy(false);
              if (work) els.saveBtn.disabled = false;
            }
            if (ok) {
              clearTimeout(toastTimer);
              els.toast.hidden = true;
            }
            if (!ok) {
              state.physicsTier = 1;
              saveSettings();
              syncUI();
              showToast('Tier-2 render failed; using Preview.');
              render();
            } else if (tier2Again) {
              tier2Again = false;
              render();
            }
          }, 20));
          return;
        }
      }

      if (renderer.physicsOk) {
        const ok = renderer.render({
          model: 'physics',
          tier: 1,
          seed: state.seed,
          grainPx: state.physicsGrain,
          layers: state.physicsLayers,
          mono: state.physicsColor === 'mono',
          rho: state.physicsRho,
          chroma: state.physicsChroma,
          amount: state.amount,
        });
        if (ok) return;
      }
      state.model = 'xt4';
      saveSettings();
      syncUI();
      showToast('Physics renderer unavailable; using X-T4.');
    }

    const p = modelParams(state.size, state.strength, state.film);
    renderer.render({
      model: 'xt4',
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
      els.cameraVideo.style.transform = '';
    }
    cameraPointers.clear();
    cameraPinchStart = null;
    if (cameraZoomRaf) {
      cancelAnimationFrame(cameraZoomRaf);
      cameraZoomRaf = 0;
    }
  }

  function resetCameraZoomState() {
    cameraZoom = 1;
    cameraZoomCap = null;
    cameraDigitalZoom = false;
    cameraDimensions = { w: 0, h: 0 };
    if (els.cameraVideo) els.cameraVideo.style.transform = '';
    if (els.cameraZoomPresets) els.cameraZoomPresets.textContent = '';
    if (els.cameraZoomBar) els.cameraZoomBar.hidden = true;
    if (cameraZoomRaf) {
      cancelAnimationFrame(cameraZoomRaf);
      cameraZoomRaf = 0;
    }
  }

  function cameraErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera access is blocked. Allow camera access for this site in Settings, or use Photos.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      if (cameraDeviceId) {
        cameraDeviceId = null;
        return 'That lens is no longer available. Try again to use the default camera, or use Photos.';
      }
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
      return 'This camera does not support the requested mode. Try again, or use Photos.';
    }
    return 'Could not start the camera. Use the phone camera or Photos instead.';
  }

  function showCameraError(err) {
    els.cameraErrorText.textContent = cameraErrorMessage(err);
    els.cameraError.hidden = false;
    els.cameraStatus.textContent = 'Camera unavailable';
  }

  async function getCameraStream(facing, deviceId) {
    const md = navigator.mediaDevices;
    const candidates = [];
    if (deviceId) {
      candidates.push({
        audio: false,
        video: { deviceId: { exact: deviceId }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      candidates.push({ audio: false, video: { deviceId: { exact: deviceId } } });
    }
    candidates.push({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    candidates.push({ audio: false, video: { facingMode: { ideal: facing } } });

    let lastErr = null;
    for (const constraints of candidates) {
      try {
        return await md.getUserMedia(constraints);
      } catch (err) {
        lastErr = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'NotReadableError')) throw err;
      }
    }
    throw lastErr;
  }

  function cameraZoomPresets() {
    const min = cameraZoomCap ? cameraZoomCap.min : 1;
    const max = cameraZoomCap ? cameraZoomCap.max : 3;
    const values = [];
    if (min < 0.75) values.push(min);
    [1, 2, 3].forEach((value) => {
      if (value >= min - 0.01 && value <= max + 0.01 &&
          !values.some((v) => Math.abs(v - value) < 0.01)) {
        values.push(value);
      }
    });
    if (max > 1.01 && max < 4 &&
        !values.some((v) => Math.abs(v - max) < 0.01)) {
      values.push(max);
    }
    if (!values.length) values.push(Math.max(min, Math.min(max, 1)));
    return values;
  }

  function formatCameraZoom(value) {
    return `${Number.isInteger(value) ? value : value.toFixed(1)}×`;
  }

  function updateCameraTransform() {
    if (!els.cameraVideo) return;
    const mirror = cameraFacing === 'user' ? -1 : 1;
    const scale = cameraDigitalZoom && cameraZoom > 1.001 ? cameraZoom : 1;
    els.cameraVideo.style.transform = `scale(${scale}) scaleX(${mirror})`;
  }

  function updateCameraZoomUI() {
    if (els.cameraZoomPresets) {
      els.cameraZoomPresets.querySelectorAll('[data-zoom]').forEach((button) => {
        button.classList.toggle(
          'active',
          Math.abs(Number(button.dataset.zoom) - cameraZoom) < 0.02,
        );
      });
    }
    const zoomText = Math.abs(cameraZoom - 1) > 0.01
      ? ` · ${cameraZoom.toFixed(1)}×`
      : '';
    els.cameraStatus.textContent = cameraDimensions.w && cameraDimensions.h
      ? `Live · ${cameraDimensions.w} × ${cameraDimensions.h}${zoomText}`
      : 'Live camera';
  }

  function renderCameraZoomPresets() {
    const bar = els.cameraZoomPresets;
    bar.textContent = '';
    cameraZoomPresets().forEach((value) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.zoom = String(value);
      button.textContent = formatCameraZoom(value);
      button.setAttribute('aria-label', `Zoom ${formatCameraZoom(value)}`);
      bar.appendChild(button);
    });
    els.cameraZoomBar.hidden = false;
    updateCameraZoomUI();
  }

  async function applyCameraZoom(value) {
    const min = cameraZoomCap ? cameraZoomCap.min : 1;
    const max = cameraZoomCap ? cameraZoomCap.max : 3;
    const next = Math.max(min, Math.min(max, Number(value) || min));
    cameraZoom = next;

    const track = cameraStream && cameraStream.getVideoTracks()[0];
    if (cameraZoomCap && track) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: next }] });
      } catch (err) {
        console.warn('Hardware zoom unavailable; switching to digital zoom.', err);
        cameraZoomCap = null;
        cameraDigitalZoom = true;
        cameraZoom = Math.max(1, Math.min(3, cameraZoom));
        renderCameraZoomPresets();
      }
    }
    if (cameraDigitalZoom) updateCameraTransform();
    updateCameraZoomUI();
  }

  async function setupCameraZoom() {
    const track = cameraStream && cameraStream.getVideoTracks()[0];
    let caps = null;
    try {
      caps = track && track.getCapabilities ? track.getCapabilities() : null;
    } catch (_) { /* no capabilities */ }

    const zoom = caps && caps.zoom;
    if (zoom && Number.isFinite(zoom.max) && zoom.max > 1.01) {
      cameraZoomCap = {
        min: Number.isFinite(zoom.min) ? zoom.min : 1,
        max: zoom.max,
        step: Number.isFinite(zoom.step) ? zoom.step : 0.1,
      };
      cameraDigitalZoom = false;
      cameraZoom = Math.max(cameraZoomCap.min, Math.min(cameraZoomCap.max, 1));
    } else {
      cameraZoomCap = null;
      cameraDigitalZoom = true;
      cameraZoom = 1;
    }

    renderCameraZoomPresets();
    await applyCameraZoom(cameraZoom);
    updateCameraTransform();
    updateCameraZoomUI();
  }

  function renderCameraLensList() {
    const list = els.cameraLensList;
    list.textContent = '';
    if (!cameraDevices.length) {
      const note = document.createElement('p');
      note.className = 'sheet-hint';
      note.textContent = 'No lens list is available in this browser.';
      list.appendChild(note);
      return;
    }
    cameraDevices.forEach((device, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'camera-lens-item' +
        (device.deviceId === cameraDeviceId ? ' active' : '');
      const name = document.createElement('span');
      name.textContent = device.label || `Camera ${index + 1}`;
      button.appendChild(name);
      if (device.deviceId === cameraDeviceId) {
        const current = document.createElement('small');
        current.textContent = 'Current';
        button.appendChild(current);
      }
      button.addEventListener('click', () => selectCameraDevice(device));
      list.appendChild(button);
    });
  }

  function lensShortName(label) {
    if (/ultra/i.test(label)) return 'Ultra';
    if (/tele/i.test(label)) return 'Tele';
    if (/front|user|facetime/i.test(label)) return 'Front';
    if (/back|rear|environment/i.test(label)) return 'Rear';
    return 'Lens';
  }

  async function refreshCameraDevices() {
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const all = await navigator.mediaDevices.enumerateDevices();
        cameraDevices = all.filter((device) => device.kind === 'videoinput');
      } else {
        cameraDevices = [];
      }
    } catch (_) {
      cameraDevices = [];
    }

    const track = cameraStream && cameraStream.getVideoTracks()[0];
    let settings = {};
    try {
      settings = track && track.getSettings ? track.getSettings() : {};
    } catch (_) { /* ignore */ }

    if (settings.deviceId) cameraDeviceId = settings.deviceId;
    if (settings.facingMode === 'user') cameraFacing = 'user';
    else if (settings.facingMode === 'environment') cameraFacing = 'environment';

    const current = cameraDevices.find((device) => device.deviceId === cameraDeviceId);
    if (current && /front|user|facetime/i.test(current.label)) cameraFacing = 'user';
    else if (current && /back|rear|environment/i.test(current.label)) cameraFacing = 'environment';
    els.cameraLensLabel.textContent = current ? lensShortName(current.label) : 'Lens';

    renderCameraLensList();
    updateCameraTransform();
  }

  async function showCameraLens() {
    if (cameraStarting) return;
    await refreshCameraDevices();
    renderCameraLensList();
    els.cameraLensSheet.hidden = false;
  }

  function closeCameraLens() {
    els.cameraLensSheet.hidden = true;
  }

  async function selectCameraDevice(device) {
    closeCameraLens();
    if (!device || device.deviceId === cameraDeviceId) return;
    cameraDeviceId = device.deviceId;
    cameraFacing = /front|user|facetime/i.test(device.label) ? 'user' : 'environment';
    await openCamera();
  }

  async function openCamera() {
    closeSheets();
    closeCameraLens();
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
    els.cameraLoadingText.textContent = 'Starting camera…';
    els.cameraStatus.textContent = 'Starting camera…';
    els.cameraShutter.disabled = true;
    els.cameraFlash.hidden = true;
    els.cameraFlash.classList.remove('on');
    stopCameraStream();
    resetCameraZoomState();

    try {
      const stream = await getCameraStream(cameraFacing, cameraDeviceId);
      if (!cameraActive || request !== cameraRequest) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream = stream;
      els.cameraVideo.srcObject = stream;
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

      cameraDimensions = {
        w: els.cameraVideo.videoWidth,
        h: els.cameraVideo.videoHeight,
      };
      await refreshCameraDevices();
      await setupCameraZoom();
      updateCameraTransform();
      updateCameraZoomUI();
      els.cameraLoading.hidden = true;
      els.cameraShutter.disabled = false;
    } catch (err) {
      if (!cameraActive || request !== cameraRequest) return;
      console.error(err);
      els.cameraLoading.hidden = true;
      els.cameraShutter.disabled = true;
      els.cameraZoomBar.hidden = true;
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
    els.cameraZoomBar.hidden = true;
    els.cameraLensSheet.hidden = true;
    els.cameraFlash.hidden = true;
    els.cameraFlash.classList.remove('on');
    resetCameraZoomState();
    els.cameraStatus.textContent = 'Camera';
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

    const zoom = cameraDigitalZoom ? cameraZoom : 1;
    const cropW = Math.max(1, Math.round(vw / zoom));
    const cropH = Math.max(1, Math.round(vh / zoom));
    const sx = Math.round((vw - cropW) / 2);
    const sy = Math.round((vh - cropH) / 2);

    const rotation = captureRotation(vw, vh);
    const swap = rotation === 90 || rotation === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? cropH : cropW;
    canvas.height = swap ? cropW : cropH;
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
    ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
    ctx.restore();

    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  }

  function scheduleCameraZoom(value) {
    cameraZoom = value;
    if (cameraDigitalZoom) updateCameraTransform();
    updateCameraZoomUI();
    if (cameraZoomRaf) return;
    cameraZoomRaf = requestAnimationFrame(() => {
      cameraZoomRaf = 0;
      applyCameraZoom(cameraZoom);
    });
  }

  function bindCameraGestures() {
    const video = els.cameraVideo;
    video.addEventListener('pointerdown', (e) => {
      if (!cameraActive || !cameraStream) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { video.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      cameraPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (cameraPointers.size === 2) {
        const points = [...cameraPointers.values()];
        cameraPinchStart = {
          dist: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y),
          zoom: cameraZoom,
        };
      }
    });

    video.addEventListener('pointermove', (e) => {
      if (!cameraPointers.has(e.pointerId)) return;
      cameraPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (cameraPointers.size !== 2 || !cameraPinchStart) return;

      const points = [...cameraPointers.values()];
      const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      if (cameraPinchStart.dist <= 0) return;
      const min = cameraZoomCap ? cameraZoomCap.min : 1;
      const max = cameraZoomCap ? cameraZoomCap.max : 3;
      const next = Math.max(min, Math.min(max, cameraPinchStart.zoom * (dist / cameraPinchStart.dist)));
      scheduleCameraZoom(next);
    });

    const end = (e) => {
      cameraPointers.delete(e.pointerId);
      if (cameraPointers.size < 2) cameraPinchStart = null;
    };
    video.addEventListener('pointerup', end);
    video.addEventListener('pointercancel', end);
  }

  async function capturePhoto() {
    if (!cameraActive || !cameraStream || els.cameraShutter.disabled) return;
    els.cameraShutter.disabled = true;
    els.cameraStatus.textContent = 'Capturing…';
    els.cameraFlash.hidden = false;
    els.cameraFlash.classList.add('on');

    try {
      await new Promise((resolve) => setTimeout(resolve, 70));
      const blob = await captureFrame();
      if (!blob) throw new Error('capture');

      els.cameraFlash.classList.remove('on');
      await new Promise((resolve) => setTimeout(resolve, 50));
      els.cameraFlash.hidden = true;

      const type = blob.type || 'image/jpeg';
      const ext = type.includes('png') ? 'png' : 'jpg';
      const file = new File([blob], `camera-${Date.now()}.${ext}`, { type });
      closeCamera();
      await handleFile(file);
    } catch (err) {
      console.error(err);
      els.cameraFlash.classList.remove('on');
      els.cameraFlash.hidden = true;
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
    document.querySelectorAll('[data-model]').forEach((b) => {
      const on = b.dataset.model === state.model;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-physics-color]').forEach((b) => {
      const on = b.dataset.physicsColor === state.physicsColor;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-physics-tier]').forEach((b) => {
      const on = Number(b.dataset.physicsTier) === state.physicsTier;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });

    const physics = state.model === 'physics';
    const tier2 = physics && state.physicsTier === 2;
    const activeLayers = tier2 ? state.physicsLayers2 : state.physicsLayers;
    document.querySelectorAll('.xt4-only').forEach((el) => { el.hidden = physics; });
    document.querySelectorAll('.physics-only').forEach((el) => { el.hidden = !physics; });

    els.amount.value = String(state.amount);
    els.amountOut.textContent = `${state.amount}%`;
    els.barAmount.textContent = `${state.amount}%`;
    els.sizeLabel.textContent = physics ? 'Grain' : 'Size';
    els.strengthLabel.textContent = physics ? 'Layers' : 'Strength';
    els.filmLabel.textContent = physics ? 'Mode' : 'Film';
    els.sizeValue.textContent = physics
      ? `${state.physicsGrain} px`
      : (state.size === 'small' ? 'Small' : 'Large');
    els.strengthValue.textContent = physics
      ? String(activeLayers)
      : (state.strength === 'weak' ? 'Weak' : 'Strong');
    els.filmValue.textContent = physics
      ? (state.physicsColor === 'mono' ? 'Mono' : 'Color')
      : (state.film === 'acros' ? 'Acros' : 'Color');
    els.modelHint.textContent = physics
      ? (state.physicsTier === 2
        ? 'Tier-2 discrete polygonal grains (WebGL2).'
        : 'Tier-1 layered-coverage physics, browser preview.')
      : 'Measured X-T4 film-grain operator.';
    els.tierHint.textContent = state.physicsTier === 2
      ? 'Tier 2 paints discrete polygonal grains layer by layer (slower); Preview uses the fast statistical field.'
      : 'Tier 1 uses the fast statistical layered-coverage field; Discrete places polygonal grains.';
    els.physicsGrain.value = String(state.physicsGrain);
    els.physicsGrainOut.textContent = `${state.physicsGrain} px`;
    els.physicsLayers.min = tier2 ? '4' : '4';
    els.physicsLayers.max = tier2 ? '40' : '160';
    els.physicsLayers.step = tier2 ? '2' : '4';
    els.physicsLayers.value = String(activeLayers);
    els.physicsLayersOut.textContent = String(activeLayers);
    els.layersHint.textContent = tier2
      ? 'Physical layers for Tier 2 (4–40). More layers give finer, subtler grain.'
      : 'Effective layers for Tier 1; the calibrated generic profile uses 120.';
    els.physicsRho.value = String(state.physicsRho);
    els.physicsRhoOut.textContent = state.physicsRho.toFixed(2);
    els.physicsChroma.value = String(state.physicsChroma);
    els.physicsChromaOut.textContent = state.physicsChroma.toFixed(2);
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

    document.querySelectorAll('[data-model]').forEach((b) => {
      b.addEventListener('click', () => {
        state.model = b.dataset.model;
        saveSettings();
        syncUI();
        render();
      });
    });

    document.querySelectorAll('[data-physics-color]').forEach((b) => {
      b.addEventListener('click', () => {
        state.physicsColor = b.dataset.physicsColor;
        saveSettings();
        syncUI();
        scheduleRender();
      });
    });

    document.querySelectorAll('[data-physics-tier]').forEach((b) => {
      b.addEventListener('click', () => {
        state.physicsTier = Number(b.dataset.physicsTier) === 2 ? 2 : 1;
        saveSettings();
        syncUI();
        render();
      });
    });

    els.physicsGrain.addEventListener('input', () => {
      state.physicsGrain = Math.max(2, Math.min(16, Number(els.physicsGrain.value) || 6));
      els.physicsGrainOut.textContent = `${state.physicsGrain} px`;
      saveSettings();
      syncUI();
      scheduleRender();
    });

    els.physicsLayers.addEventListener('input', () => {
      if (state.physicsTier === 2) {
        state.physicsLayers2 = Math.max(4, Math.min(40, Number(els.physicsLayers.value) || 20));
        els.physicsLayersOut.textContent = String(state.physicsLayers2);
      } else {
        state.physicsLayers = Math.max(4, Math.min(160, Number(els.physicsLayers.value) || 120));
        els.physicsLayersOut.textContent = String(state.physicsLayers);
      }
      saveSettings();
      syncUI();
      scheduleRender();
    });

    els.physicsRho.addEventListener('input', () => {
      state.physicsRho = Math.max(0, Math.min(0.95, Number(els.physicsRho.value) || 0));
      els.physicsRhoOut.textContent = state.physicsRho.toFixed(2);
      saveSettings();
      syncUI();
      scheduleRender();
    });

    els.physicsChroma.addEventListener('input', () => {
      state.physicsChroma = Math.max(0, Math.min(1, Number(els.physicsChroma.value) || 0));
      els.physicsChromaOut.textContent = state.physicsChroma.toFixed(2);
      saveSettings();
      syncUI();
      scheduleRender();
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
    els.cameraLens.addEventListener('click', showCameraLens);
    els.cameraLensClose.addEventListener('click', closeCameraLens);
    els.cameraLensSheet.addEventListener('click', (e) => {
      if (e.target === els.cameraLensSheet) closeCameraLens();
    });
    els.cameraZoomBar.addEventListener('click', (e) => {
      const button = e.target.closest('[data-zoom]');
      if (button) applyCameraZoom(Number(button.dataset.zoom));
    });
    bindCameraGestures();
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
      const tag = state.model === 'physics'
        ? `physics-t${state.physicsTier}-${state.physicsGrain}px-${state.physicsTier === 2 ? state.physicsLayers2 : state.physicsLayers}l`
        : `${state.size}-${state.strength}`;
      const name = `grain-${tag}-${Date.now()}.${ext}`;
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
