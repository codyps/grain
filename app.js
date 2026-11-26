/* X-T4 film grain — local, installable PWA.
 *
 * Model measured from controlled camera conversions:
 *   Small: uniform white noise, std 5.06 (weak) / 9.83 (strong)
 *   Large: uniform noise + separable 5-tap low-pass
 *          weak 2.74, kernel [0.169, 0.452, 1, 0.452, 0.169]
 *          strong 5.05, kernel [0.186, 0.548, 1, 0.548, 0.186]
 * The field is added equally to R/G/B and clipped to 0..255.
 */
(() => {
  'use strict';

  const MODEL = {
    small: {
      weak: { std: 5.06, k1: 0, k2: 0 },
      strong: { std: 9.83, k1: 0, k2: 0 },
    },
    large: {
      weak: { std: 2.74, k1: 0.452, k2: 0.169 },
      strong: { std: 5.05, k1: 0.548, k2: 0.186 },
    },
  };

  const DEFAULTS = {
    size: 'large',
    strength: 'strong',
    amount: 100,
    seed: 517,
    gate: true,
    maxEdge: 4096,
    format: 'jpeg',
  };

  const STORAGE_KEY = 'xt4grain.settings.v1';
  const $ = (id) => document.getElementById(id);

  const els = {
    view: $('view'),
    original: $('original'),
    canvasWrap: $('canvasWrap'),
    empty: $('empty'),
    busy: $('busy'),
    status: $('status'),
    compareBtn: $('compareBtn'),
    saveBtn: $('saveBtn'),
    takeBtn: $('takeBtn'),
    chooseBtn: $('chooseBtn'),
    cameraInput: $('cameraInput'),
    galleryInput: $('galleryInput'),
    amount: $('amount'),
    amountOut: $('amountOut'),
    seedOut: $('seedOut'),
    shuffleBtn: $('shuffleBtn'),
    gate: $('gate'),
    resolution: $('resolution'),
    resetBtn: $('resetBtn'),
    installBtn: $('installBtn'),
    iosHint: $('iosHint'),
  };

  let state = loadSettings();
  let source = null;        // { bitmap, w, h, url? }
  let work = null;          // { canvas, w, h }
  let renderer = null;
  let renderTimer = 0;
  let statusTimer = 0;
  let busyCount = 0;

  // ---------------------------------------------------------------- settings

  function loadSettings() {
    const s = { ...DEFAULTS };
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      if (raw.size === 'small' || raw.size === 'large') s.size = raw.size;
      if (raw.strength === 'weak' || raw.strength === 'strong') s.strength = raw.strength;
      if (Number.isFinite(raw.amount)) s.amount = Math.max(0, Math.min(200, Math.round(raw.amount)));
      if (Number.isFinite(raw.seed)) s.seed = Math.max(0, Math.min(4095, Math.round(raw.seed)));
      if (typeof raw.gate === 'boolean') s.gate = raw.gate;
      if ([0, 2048, 3072, 4096].includes(raw.maxEdge)) s.maxEdge = raw.maxEdge;
      if (raw.format === 'jpeg' || raw.format === 'png') s.format = raw.format;
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

  /** Convert the measured 8-bit target std into the shader's gain. */
  function computeGain(size, strength, amount) {
    const m = MODEL[size][strength];
    const std = m.std * (amount / 100);
    if (size === 'small') return std * Math.sqrt(3); // uniform [-1,1] has std 1/sqrt(3)
    const norm = 1 + 2 * m.k1 + 2 * m.k2;
    let sumW2 = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const w = (kw(dx, m.k1, m.k2) * kw(dy, m.k1, m.k2)) / (norm * norm);
        sumW2 += w * w;
      }
    }
    return std / Math.sqrt(sumW2 / 3);
  }

  function modelLabel() {
    const size = state.size === 'small' ? 'Small' : 'Large';
    const strength = state.strength === 'weak' ? 'Weak' : 'Strong';
    return `${size} · ${strength} · ${state.amount}%`;
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
    uniform float u_large;
    uniform float u_k1;
    uniform float u_k2;
    uniform float u_gate;
    varying vec2 v_uv;

    float hash(vec2 p, float seed) {
      float s = mod(seed, 4096.0);
      p += vec2(s * 0.137, s * 0.271);
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float kw(float d) {
      d = abs(d);
      return d < 0.5 ? 1.0 : (d < 1.5 ? u_k1 : u_k2);
    }

    void main() {
      vec3 c = texture2D(u_image, v_uv).rgb;
      float n;
      if (u_large < 0.5) {
        n = hash(gl_FragCoord.xy, u_seed) * 2.0 - 1.0;
      } else {
        float s = 0.0;
        for (int dy = -2; dy <= 2; dy++) {
          for (int dx = -2; dx <= 2; dx++) {
            float w = kw(float(dx)) * kw(float(dy));
            s += (hash(gl_FragCoord.xy + vec2(float(dx), float(dy)), u_seed) * 2.0 - 1.0) * w;
          }
        }
        float norm = 1.0 + 2.0 * u_k1 + 2.0 * u_k2;
        n = s / (norm * norm);
      }
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      float gate = mix(1.0, smoothstep(0.0, 0.08, lum), u_gate);
      gl_FragColor = vec4(clamp(c + vec3(n * u_gain * gate / 255.0), 0.0, 1.0), 1.0);
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
        large: gl.getUniformLocation(p, 'u_large'),
        k1: gl.getUniformLocation(p, 'u_k1'),
        k2: gl.getUniformLocation(p, 'u_k2'),
        gate: gl.getUniformLocation(p, 'u_gate'),
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
      gl.uniform1f(this.u.large, p.large ? 1 : 0);
      gl.uniform1f(this.u.k1, p.k1);
      gl.uniform1f(this.u.k2, p.k2);
      gl.uniform1f(this.u.gate, p.gate ? 1 : 0);
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

  function prepare() {
    const { w, h } = workSize(source.w, source.h);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.bitmap, 0, 0, w, h);

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
      setStatus(renderer ? renderer.error : 'WebGL is not available.');
      return;
    }
    setBusy(true);
    setStatus('Loading…');
    try {
      const next = await decodeFile(file);
      if (source && source.url) URL.revokeObjectURL(source.url);
      if (source && source.bitmap && source.bitmap.close) source.bitmap.close();
      source = next;

      try {
        prepare();
      } catch (err) {
        if (state.maxEdge === 0 || state.maxEdge > 4096) {
          setStatus('Image too large; retrying at 4096 px…');
          const old = state.maxEdge;
          state.maxEdge = 4096;
          saveSettings();
          syncUI();
          try { prepare(); } catch (_) { state.maxEdge = old; saveSettings(); syncUI(); throw err; }
        } else {
          throw err;
        }
      }

      els.canvasWrap.hidden = false;
      els.empty.hidden = true;
      els.compareBtn.disabled = false;
      els.saveBtn.disabled = false;
      els.takeBtn.classList.remove('primary');
      els.saveBtn.classList.add('primary');
      showOriginal(false);
      els.compareBtn.textContent = 'Compare';
      els.compareBtn.setAttribute('aria-pressed', 'false');
      render();
      updateStatus();
    } catch (err) {
      console.error(err);
      const msg = err && err.message === 'decode'
        ? 'Could not read that image. Try a JPEG export.'
        : (err && err.message) || 'Could not process that image.';
      setStatus(msg);
    } finally {
      setBusy(false);
    }
  }

  function render() {
    if (!work || !source) return;
    if (!renderer || !renderer.ok) {
      setStatus(renderer ? renderer.error : 'WebGL is not available.');
      return;
    }
    const m = MODEL[state.size][state.strength];
    renderer.render({
      seed: state.seed,
      gain: computeGain(state.size, state.strength, state.amount),
      large: state.size === 'large',
      k1: m.k1,
      k2: m.k2,
      gate: state.gate,
    });
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 60);
  }

  function showOriginal(on) {
    if (!work) return;
    els.original.hidden = !on;
  }

  // -------------------------------------------------------------------- UI

  function setBusy(on) {
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    els.busy.hidden = busyCount === 0;
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function flashStatus(text) {
    clearTimeout(statusTimer);
    setStatus(text);
    statusTimer = setTimeout(() => {
      if (work && source) updateStatus();
    }, 3000);
  }

  function updateStatus() {
    if (!work || !source) return;
    const dims = (work.w === source.w && work.h === source.h)
      ? `${work.w} × ${work.h}`
      : `${source.w} × ${source.h} → ${work.w} × ${work.h}`;
    setStatus(`${dims} · ${modelLabel()}`);
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
    document.querySelectorAll('[data-format]').forEach((b) => {
      const on = b.dataset.format === state.format;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    els.amount.value = String(state.amount);
    els.amountOut.textContent = `${state.amount}%`;
    els.seedOut.textContent = String(state.seed);
    els.gate.checked = state.gate;
    els.resolution.value = String(state.maxEdge);
    updateStatus();
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
      saveSettings();
      scheduleRender();
    });

    els.shuffleBtn.addEventListener('click', () => {
      state.seed = Math.floor(Math.random() * 4096);
      saveSettings();
      syncUI();
      render();
    });

    els.gate.addEventListener('change', () => {
      state.gate = els.gate.checked;
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
        } catch (err) {
          console.error(err);
          setStatus('Could not resize; try 4096 px.');
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
    });

    els.takeBtn.addEventListener('click', () => els.cameraInput.click());
    els.chooseBtn.addEventListener('click', () => els.galleryInput.click());

    const onPick = (input) => {
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (file) handleFile(file);
      });
    };
    onPick(els.cameraInput);
    onPick(els.galleryInput);

    els.compareBtn.addEventListener('click', () => {
      const show = els.original.hidden;
      showOriginal(show);
      els.compareBtn.setAttribute('aria-pressed', String(show));
      els.compareBtn.textContent = show ? 'Show grain' : 'Compare';
    });

    els.saveBtn.addEventListener('click', saveImage);

    // Desktop drag and drop.
    const frame = $('frame');
    frame.addEventListener('dragover', (e) => {
      e.preventDefault();
      frame.classList.add('dragover');
    });
    frame.addEventListener('dragleave', () => frame.classList.remove('dragover'));
    frame.addEventListener('drop', (e) => {
      e.preventDefault();
      frame.classList.remove('dragover');
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
          flashStatus(`Shared ${ext.toUpperCase()}`);
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
      flashStatus(`Saved ${ext.toUpperCase()}`);
    } catch (err) {
      console.error(err);
      setStatus('Could not save the image.');
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
      els.installBtn.hidden = false;
    });
    els.installBtn.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (_) { /* ignore */ }
      deferred = null;
      els.installBtn.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      els.installBtn.hidden = true;
    });

    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches ||
      navigator.standalone === true;
    if (isIOS && !standalone) els.iosHint.hidden = false;
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    renderer = new GrainRenderer(els.view);
    if (!renderer.ok) {
      setStatus(renderer.error || 'WebGL is not available.');
      els.empty.querySelector('strong').textContent = 'WebGL required';
      els.empty.querySelector('span').textContent =
        'This browser cannot run the grain renderer. Try Safari, Chrome, or Firefox on a recent device.';
    }
    bind();
    syncUI();
    initPWA();
  }

  boot();
})();
