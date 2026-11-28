/* Tier-2 layered Poisson coverage renderer (WebGL2).
 *
 * Browser counterpart of work/grain-physics/layered_grain.py. Each layer
 * paints polygonal grain footprints at Poisson seeds; layers are thresholded,
 * accumulated, blurred by a small PSF, and composited as a signed density
 * deviation. Color layers share a fraction rho of seeds.
 */
(() => {
  'use strict';

  const QUAD_VERT = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main() {
      v_uv = a_pos * 0.5 + 0.5;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  const POINT_VERT = `
    attribute vec2 a_pos;
    attribute vec3 a_color;
    uniform vec2 u_texSize;
    uniform float u_pointSize;
    varying vec3 v_color;
    void main() {
      vec2 p = a_pos / u_texSize * 2.0 - 1.0;
      gl_Position = vec4(p, 0.0, 1.0);
      gl_PointSize = u_pointSize;
      v_color = a_color;
    }
  `;

  const POINT_FRAG = `
    precision highp float;
    uniform float u_vertices;
    uniform float u_rotation;
    varying vec3 v_color;
    void main() {
      vec2 q = gl_PointCoord * 2.0 - 1.0;
      float r = length(q);
      float theta = atan(q.y, q.x);
      float n = max(u_vertices, 3.0);
      float env = cos(3.141592653589793 / n) /
        cos((2.0 * asin(cos(n * (theta + u_rotation))) + 3.141592653589793) / (2.0 * n));
      if (r > env) discard;
      gl_FragColor = vec4(v_color, 1.0);
    }
  `;

  const P_FRAG = `
    precision highp float;
    uniform sampler2D u_image;
    uniform float u_mono;
    varying vec2 v_uv;

    vec3 srgbToLinear(vec3 c) {
      vec3 lo = c / 12.92;
      vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
      return mix(hi, lo, 1.0 - step(vec3(0.04045), c));
    }

    void main() {
      vec3 lin = srgbToLinear(clamp(texture2D(u_image, v_uv).rgb, 0.0, 1.0));
      float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
      vec3 p = u_mono > 0.5 ? vec3(1.0 - y) : 1.0 - lin;
      gl_FragColor = vec4(clamp(p, 0.0, 1.0), 1.0);
    }
  `;

  const ACCUM_FRAG = `
    precision highp float;
    uniform sampler2D u_layer;
    uniform sampler2D u_p;
    uniform sampler2D u_prev;
    uniform float u_invN;
    varying vec2 v_uv;

    void main() {
      vec3 p = texture2D(u_p, v_uv).rgb;
      vec3 layer = texture2D(u_layer, v_uv).rgb;
      vec3 cov = step(vec3(0.5), layer);
      vec3 extreme = clamp(step(vec3(0.97), p) + step(p, vec3(0.03)), 0.0, 1.0);
      cov = mix(cov, p, extreme);
      vec3 dev = p - cov;
      vec3 prev = texture2D(u_prev, v_uv).rgb;
      gl_FragColor = vec4(prev + dev * u_invN, 1.0);
    }
  `;

  const PSF_FRAG = `
    precision highp float;
    uniform sampler2D u_src;
    uniform vec2 u_texSize;
    varying vec2 v_uv;

    void main() {
      vec3 sum = vec3(0.0);
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          float w = (x == 0 && y == 0) ? 0.337 :
                    ((x == 0 || y == 0) ? 0.122 : 0.044);
          sum += texture2D(u_src, v_uv + vec2(float(x), float(y)) / u_texSize).rgb * w;
        }
      }
      gl_FragColor = vec4(sum, 1.0);
    }
  `;

  const COMP_FRAG = `
    precision highp float;
    uniform sampler2D u_image;
    uniform sampler2D u_dev;
    uniform sampler2D u_lut;
    uniform float u_amount;
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

    float lutCorrection(float p) {
      return texture2D(u_lut, vec2((p * 255.0 + 0.5) / 256.0, 0.5)).r;
    }

    void main() {
      vec3 c = texture2D(u_image, v_uv).rgb;
      vec3 lin = srgbToLinear(clamp(c, 0.0, 1.0));
      vec3 p = u_mono > 0.5
        ? vec3(1.0 - dot(lin, vec3(0.2126, 0.7152, 0.0722)))
        : 1.0 - lin;
      vec3 dev = texture2D(u_dev, v_uv).rgb * u_amount;

      if (u_mono > 0.5) {
        float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
        lin *= (y + dev.r) / max(y, 1e-4);
      } else {
        float yDev = dot(dev, vec3(0.2126, 0.7152, 0.0722));
        dev = yDev + u_chroma * (dev - yDev);
        lin += dev;
      }

      vec3 outS = linearToSrgb(clamp(lin, 0.0, 1.0));
      float corrScale = 0.05 * u_amount * u_amount;
      if (u_mono > 0.5) {
        outS += vec3(lutCorrection(p.r) * corrScale);
      } else {
        outS += vec3(lutCorrection(p.r), lutCorrection(p.g), lutCorrection(p.b)) * corrScale;
      }
      gl_FragColor = vec4(clamp(outS, 0.0, 1.0), 1.0);
    }
  `;

  const TILE = 4;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    const u1 = Math.max(rng(), 1e-7);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  class Tier2Renderer {
    constructor(gl, imageTexture, canvas, maxTextureSize) {
      this.gl = gl;
      this.imageTexture = imageTexture;
      this.canvas = canvas;
      this.maxTextureSize = maxTextureSize;
      this.ok = false;
      this.error = '';
      this.tgt = null;
      this.pData = null;
      this.tileMean = null;
      this.tileW = 0;
      this.tileH = 0;
      this.sig = '';
      this.pSig = '';
      this.imageVersion = 0;
      this.pointBuffer = null;

      if (typeof WebGL2RenderingContext === 'undefined' ||
          !(gl instanceof WebGL2RenderingContext)) {
        this.error = 'Tier 2 requires WebGL2.';
        return;
      }
      this.floatExt = gl.getExtension('EXT_color_buffer_float') ||
        gl.getExtension('EXT_color_buffer_half_float');
      if (!this.floatExt) {
        this.error = 'Tier 2 requires half-float render targets.';
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
        this.error = gl.getShaderInfoLog(sh) || 'Tier 2 shader compile failed.';
        console.error(this.error);
        return null;
      }
      return sh;
    }

    makeProgram(vsSource, fsSource) {
      const gl = this.gl;
      const vs = this.compile(gl.VERTEX_SHADER, vsSource);
      const fs = this.compile(gl.FRAGMENT_SHADER, fsSource);
      if (!vs || !fs) return null;
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        this.error = gl.getProgramInfoLog(program) || 'Tier 2 program link failed.';
        console.error(this.error);
        return null;
      }
      return program;
    }

    init() {
      const gl = this.gl;
      this.pProgram = this.makeProgram(QUAD_VERT, P_FRAG);
      this.accumProgram = this.makeProgram(QUAD_VERT, ACCUM_FRAG);
      this.psfProgram = this.makeProgram(QUAD_VERT, PSF_FRAG);
      this.compProgram = this.makeProgram(QUAD_VERT, COMP_FRAG);
      this.pointProgram = this.makeProgram(POINT_VERT, POINT_FRAG);
      if (!this.pProgram || !this.accumProgram || !this.psfProgram ||
          !this.compProgram || !this.pointProgram) {
        return;
      }

      this.pU = {
        image: gl.getUniformLocation(this.pProgram, 'u_image'),
        mono: gl.getUniformLocation(this.pProgram, 'u_mono'),
      };
      this.accumU = {
        layer: gl.getUniformLocation(this.accumProgram, 'u_layer'),
        p: gl.getUniformLocation(this.accumProgram, 'u_p'),
        prev: gl.getUniformLocation(this.accumProgram, 'u_prev'),
        invN: gl.getUniformLocation(this.accumProgram, 'u_invN'),
      };
      this.psfU = {
        src: gl.getUniformLocation(this.psfProgram, 'u_src'),
        texSize: gl.getUniformLocation(this.psfProgram, 'u_texSize'),
      };
      this.compU = {
        image: gl.getUniformLocation(this.compProgram, 'u_image'),
        dev: gl.getUniformLocation(this.compProgram, 'u_dev'),
        lut: gl.getUniformLocation(this.compProgram, 'u_lut'),
        amount: gl.getUniformLocation(this.compProgram, 'u_amount'),
        mono: gl.getUniformLocation(this.compProgram, 'u_mono'),
        chroma: gl.getUniformLocation(this.compProgram, 'u_chroma'),
      };
      this.pointU = {
        texSize: gl.getUniformLocation(this.pointProgram, 'u_texSize'),
        pointSize: gl.getUniformLocation(this.pointProgram, 'u_pointSize'),
        vertices: gl.getUniformLocation(this.pointProgram, 'u_vertices'),
        rotation: gl.getUniformLocation(this.pointProgram, 'u_rotation'),
      };
      this.pointA = {
        pos: gl.getAttribLocation(this.pointProgram, 'a_pos'),
        color: gl.getAttribLocation(this.pointProgram, 'a_color'),
      };

      const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
      this.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
      this.pointBuffer = gl.createBuffer();

      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      this.maxPointSize = range && range.length ? range[1] : 64;
      this.lutTex = null;
      this.lutLayers = 0;
      this.ok = true;
    }

    invalidate() {
      this.imageVersion++;
      this.sig = '';
      this.pSig = '';
    }

    createTarget(w, h, internal, format, type) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('Tier 2 target incomplete:', status);
        gl.deleteTexture(tex);
        gl.deleteFramebuffer(fbo);
        return null;
      }
      return { tex, fbo, w, h };
    }

    deleteTargets() {
      const gl = this.gl;
      if (!this.tgt) return;
      ['p', 'layer', 'accumA', 'accumB', 'psf'].forEach((key) => {
        const t = this.tgt[key];
        if (!t) return;
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      });
      this.tgt = null;
      this.sig = '';
      this.pSig = '';
    }

    ensureTargets(w, h) {
      if (this.tgt && this.tgt.w === w && this.tgt.h === h) return true;
      this.deleteTargets();
      const gl = this.gl;
      const p = this.createTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const layer = this.createTarget(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      const accumA = this.createTarget(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
      const accumB = this.createTarget(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
      const psf = this.createTarget(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
      if (!p || !layer || !accumA || !accumB || !psf) {
        [p, layer, accumA, accumB, psf].forEach((t) => {
          if (!t) return;
          gl.deleteTexture(t.tex);
          gl.deleteFramebuffer(t.fbo);
        });
        this.ok = false;
        this.error = 'Tier 2 render targets are unavailable.';
        return false;
      }
      this.tgt = { w, h, p, layer, accumA, accumB, psf };
      this.pData = new Uint8Array(w * h * 4);
      this.sig = '';
      this.pSig = '';
      return true;
    }

    bindQuad(program) {
      const gl = this.gl;
      const loc = gl.getAttribLocation(program, 'a_pos');
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    buildP(w, h, mono) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tgt.p.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.pProgram);
      this.bindQuad(this.pProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.uniform1i(this.pU.image, 0);
      gl.uniform1f(this.pU.mono, mono ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.pData);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.tileW = Math.ceil(w / TILE);
      this.tileH = Math.ceil(h / TILE);
      this.tileMean = new Float32Array(this.tileW * this.tileH * 3);
      for (let ty = 0; ty < this.tileH; ty++) {
        const y0 = ty * TILE;
        const y1 = Math.min(h, y0 + TILE);
        for (let tx = 0; tx < this.tileW; tx++) {
          const x0 = tx * TILE;
          const x1 = Math.min(w, x0 + TILE);
          let sr = 0, sg = 0, sb = 0, n = 0;
          for (let y = y0; y < y1; y++) {
            let i = (y * w + x0) * 4;
            for (let x = x0; x < x1; x++, i += 4) {
              sr += this.pData[i];
              sg += this.pData[i + 1];
              sb += this.pData[i + 2];
              n++;
            }
          }
          const o = (ty * this.tileW + tx) * 3;
          const inv = n ? 1 / (n * 255) : 0;
          this.tileMean[o] = sr * inv;
          this.tileMean[o + 1] = sg * inv;
          this.tileMean[o + 2] = sb * inv;
        }
      }
    }

    makeKernel(meanPx, rng) {
      let size = Math.exp(Math.log(Math.max(meanPx, 1)) + 0.3 * gaussian(rng));
      size = clamp(size, 3, Math.max(3, meanPx * 3));
      size = Math.round(size);
      if (size % 2 === 0) size += 1;
      size = Math.min(size, this.maxPointSize);
      const vertices = Math.round(clamp(6 + 1.5 * gaussian(rng), 3, 10));
      const rotation = rng() * Math.PI * 2;

      // The Python prototype uses the rasterized kernel count, not the
      // continuous polygon area. Match the point-sprite footprint here.
      let area = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const qx = (2 * (x + 0.5)) / size - 1;
          const qy = (2 * (y + 0.5)) / size - 1;
          const r = Math.hypot(qx, qy);
          const theta = Math.atan2(qy, qx);
          const n = Math.max(3, vertices);
          const env = Math.cos(Math.PI / n) /
            Math.cos((2 * Math.asin(Math.cos(n * (theta + rotation))) + Math.PI) / (2 * n));
          if (r <= env + 1e-6) area++;
        }
      }

      return { size, vertices, rotation, area: Math.max(1, area * 1.025) };
    }

    seedProbability(p, area) {
      const q = clamp(p, 0.0001, 0.9999);
      return 1 - Math.pow(1 - q, 1 / Math.max(area, 0.5));
    }

    countExpected(expected, rng) {
      const base = Math.floor(expected);
      return base + (rng() < expected - base ? 1 : 0);
    }

    addPoint(points, index, x, y, r, g, b) {
      if (index + 5 > points.length) {
        const bigger = new Float32Array(points.length * 2);
        bigger.set(points);
        points = bigger;
      }
      points[index++] = x;
      points[index++] = y;
      points[index++] = r;
      points[index++] = g;
      points[index++] = b;
      return { points, index };
    }

    buildLayers(w, h, layers, rho, seed, grainPx) {
      const gl = this.gl;
      const mono = this.mono;
      const meanPx = Math.max(1, (grainPx * w) / this.canvas.width);

      // Clear both accumulation targets.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tgt.accumA.fbo);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tgt.accumB.fbo);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      let prev = this.tgt.accumA;
      let next = this.tgt.accumB;

      for (let layer = 0; layer < layers; layer++) {
        const rng = mulberry32((seed * 2654435761 + layer * 0x9E3779B9) >>> 0);
        const kernel = this.makeKernel(meanPx, rng);

        // First pass: estimate the point count for this layer.
        let total = 0;
        for (let ty = 0; ty < this.tileH; ty++) {
          const y0 = ty * TILE;
          const th = Math.min(TILE, h - y0);
          for (let tx = 0; tx < this.tileW; tx++) {
            const tw = Math.min(TILE, w - tx * TILE);
            const area = tw * th;
            const o = (ty * this.tileW + tx) * 3;
            if (mono) {
              const p = this.tileMean[o];
              if (p > 0.03 && p < 0.97) {
                total += area * this.seedProbability(p, kernel.area);
              }
            } else {
              const pR = this.tileMean[o];
              const pG = this.tileMean[o + 1];
              const pB = this.tileMean[o + 2];
              const sR = this.seedProbability(pR, kernel.area);
              const sG = this.seedProbability(pG, kernel.area);
              const sB = this.seedProbability(pB, kernel.area);
              const sCommon = rho * Math.min(sR, sG, sB);
              const inv = sCommon < 1 ? 1 / (1 - sCommon) : 0;
              total += area * (sCommon +
                Math.max(0, (sR - sCommon) * inv) +
                Math.max(0, (sG - sCommon) * inv) +
                Math.max(0, (sB - sCommon) * inv));
            }
          }
        }

        let points = new Float32Array(Math.ceil(total * 1.15 + 1024) * 5);
        let index = 0;

        for (let ty = 0; ty < this.tileH; ty++) {
          const y0 = ty * TILE;
          const th = Math.min(TILE, h - y0);
          for (let tx = 0; tx < this.tileW; tx++) {
            const tw = Math.min(TILE, w - tx * TILE);
            const area = tw * th;
            const o = (ty * this.tileW + tx) * 3;
            const add = (count, r, g, b) => {
              for (let k = 0; k < count; k++) {
                const x = tx * TILE + rng() * tw;
                const y = ty * TILE + rng() * th;
                const res = this.addPoint(points, index, x, y, r, g, b);
                points = res.points;
                index = res.index;
              }
            };

            if (mono) {
              const p = this.tileMean[o];
              if (p > 0.03 && p < 0.97) {
                const s = this.seedProbability(p, kernel.area);
                add(this.countExpected(area * s, rng), 1, 1, 1);
              }
            } else {
              const pR = this.tileMean[o];
              const pG = this.tileMean[o + 1];
              const pB = this.tileMean[o + 2];
              const sR = this.seedProbability(pR, kernel.area);
              const sG = this.seedProbability(pG, kernel.area);
              const sB = this.seedProbability(pB, kernel.area);
              const sCommon = rho * Math.min(sR, sG, sB);
              const inv = sCommon < 1 ? 1 / (1 - sCommon) : 0;
              const iR = Math.max(0, (sR - sCommon) * inv);
              const iG = Math.max(0, (sG - sCommon) * inv);
              const iB = Math.max(0, (sB - sCommon) * inv);
              add(this.countExpected(area * sCommon, rng), 1, 1, 1);
              add(this.countExpected(area * iR, rng), 1, 0, 0);
              add(this.countExpected(area * iG, rng), 0, 1, 0);
              add(this.countExpected(area * iB, rng), 0, 0, 1);
            }
          }
        }

        // Paint this layer's polygon union.
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.tgt.layer.fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (index > 0) {
          gl.useProgram(this.pointProgram);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.pointBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, points.subarray(0, index), gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(this.pointA.pos);
          gl.vertexAttribPointer(this.pointA.pos, 2, gl.FLOAT, false, 20, 0);
          gl.enableVertexAttribArray(this.pointA.color);
          gl.vertexAttribPointer(this.pointA.color, 3, gl.FLOAT, false, 20, 8);
          gl.uniform2f(this.pointU.texSize, w, h);
          gl.uniform1f(this.pointU.pointSize, kernel.size);
          gl.uniform1f(this.pointU.vertices, kernel.vertices);
          gl.uniform1f(this.pointU.rotation, kernel.rotation);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.drawArrays(gl.POINTS, 0, index / 5);
          gl.disable(gl.BLEND);
        }

        // Threshold and accumulate p - coverage.
        gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
        gl.viewport(0, 0, w, h);
        gl.useProgram(this.accumProgram);
        this.bindQuad(this.accumProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tgt.layer.tex);
        gl.uniform1i(this.accumU.layer, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.tgt.p.tex);
        gl.uniform1i(this.accumU.p, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, prev.tex);
        gl.uniform1i(this.accumU.prev, 2);
        gl.uniform1f(this.accumU.invN, 1 / layers);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        const swap = prev;
        prev = next;
        next = swap;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tgt.psf.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.psfProgram);
      this.bindQuad(this.psfProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, prev.tex);
      gl.uniform1i(this.psfU.src, 0);
      gl.uniform2f(this.psfU.texSize, w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    srgbEncode(x) {
      const c = clamp(x, 0, 1);
      return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    }

    buildLut(layers) {
      const gl = this.gl;
      const data = new Uint8Array(256 * 4);
      for (let i = 0; i < 256; i++) {
        const p = i / 255;
        const base = this.srgbEncode(1 - p);
        let expected = 0;
        if (p <= 0) {
          expected = 1;
        } else if (p >= 1) {
          expected = 0;
        } else {
          let prob = Math.pow(1 - p, layers);
          for (let k = 0; k <= layers; k++) {
            expected += prob * this.srgbEncode(1 - k / layers);
            prob *= ((layers - k) / (k + 1)) * (p / (1 - p));
          }
        }
        const corr = clamp(base - expected, 0, 0.05);
        const v = Math.round((corr / 0.05) * 255);
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      if (!this.lutTex) this.lutTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      this.lutLayers = layers;
    }

    composite(amount, chroma, mono) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(this.compProgram);
      this.bindQuad(this.compProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
      gl.uniform1i(this.compU.image, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tgt.psf.tex);
      gl.uniform1i(this.compU.dev, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.uniform1i(this.compU.lut, 2);
      gl.uniform1f(this.compU.amount, amount);
      gl.uniform1f(this.compU.mono, mono ? 1 : 0);
      gl.uniform1f(this.compU.chroma, chroma);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    render(p) {
      if (!this.ok) return false;
      const gl = this.gl;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const maxEdge = Math.min(2048, this.maxTextureSize);
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      const texW = Math.max(1, Math.round(w * scale));
      const texH = Math.max(1, Math.round(h * scale));
      const layers = Math.max(4, Math.min(40, Math.round(p.layers || 20)));
      const mono = !!p.mono;
      const rho = clamp(Number.isFinite(p.rho) ? p.rho : 0.7, 0, 0.95);
      this.mono = mono;

      if (!this.ensureTargets(texW, texH)) return false;

      const pSig = `${this.imageVersion}|${texW}x${texH}|${mono ? 1 : 0}`;
      if (pSig !== this.pSig) {
        this.buildP(texW, texH, mono);
        this.pSig = pSig;
      }

      const sig = `${pSig}|${p.seed}|${Number(p.grainPx).toFixed(2)}|${layers}|${rho.toFixed(3)}`;
      if (sig !== this.sig) {
        this.buildLayers(texW, texH, layers, rho, p.seed, p.grainPx);
        this.sig = sig;
      }
      if (this.lutLayers !== layers) this.buildLut(layers);

      this.composite((p.amount || 0) / 100, Number.isFinite(p.chroma) ? p.chroma : 0.4, mono);
      return true;
    }
  }

  window.Tier2Renderer = Tier2Renderer;
})();
