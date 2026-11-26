# GRAIN — X-T4 film grain (PWA)

An installable, offline photo editor that adds the measured X-T4 film-grain
effect to photos. It runs entirely in the browser: no uploads, no account.

## Features

- **Camera or library**: `Camera` opens the rear camera; `Photos` opens the
  photo picker.
- **Local processing**: WebGL shader, no server.
- **Controls**: Small/Large grain, Weak/Strong strength, Amount 0–200%,
  Seed + Shuffle, Shadow gate, working resolution, JPEG/PNG.
- **Compare** toggle against the original.
- **Installable PWA**: Android install prompt; iOS Add to Home Screen.
- **Offline**: the app shell is cached by a service worker.
- **Persistent settings**: size, strength, amount, seed, gate, resolution and
  format are stored in `localStorage`.
- **App shell**: the header and action dock stay fixed; only the content area
  scrolls.

## Grain model

Measured from controlled RAF conversions on an X-T4 (firmware 2.12):

| Size | Strength | Std (8-bit) | Kernel |
| --- | --- | ---: | --- |
| Small | Weak | 5.06 | delta (white uniform) |
| Small | Strong | 9.83 | delta (white uniform) |
| Large | Weak | 2.74 | 0.169, 0.452, 1, 0.452, 0.169 |
| Large | Strong | 5.05 | 0.186, 0.548, 1, 0.548, 0.186 |

`Amount` scales the measured amplitude; 100% is the measured baseline (so the
slider thumb sits at the midpoint of 0–200%). The same monochrome field is
added to R/G/B, clipped to 0–255. The shadow gate fades the grain near black,
matching the camera's black-point behavior.

## Run locally

```sh
cd work/grain-web
python3 -m http.server 8000
```

Open <http://localhost:8000>. Service worker and install require **localhost or
HTTPS**; a plain `http://<LAN-IP>` is not a secure context.

## Deploy

See [`deploy/README.md`](deploy/README.md) for the host comparison and
one-command scripts (Netlify, Cloudflare Pages, GitHub Pages). The app is a
static folder; serve it over HTTPS. `manifest.json` is served as JSON by
static hosts, so no MIME configuration is needed. `_headers` adds CSP and cache
headers on Netlify and Cloudflare Pages; GitHub Pages ignores it (see the
notes).

Bump `CACHE` in `sw.js` when you deploy changes.

## Install

- **Android / Chrome**: use the `Install` button, or menu → *Install app*.
- **iOS / Safari**: Share → **Add to Home Screen**. The app shows this hint
  when it detects iOS outside standalone mode.

## Validation

A headless Chromium + SwiftShader test loaded a flat-field image, measured the
rendered grain against the amount-0 reference, and exercised the controls,
compare overlay, save/download, service worker and manifest:

| Setting | Expected std | Rendered std |
| --- | ---: | ---: |
| Large / Strong | 5.05 | 5.055 |
| Small / Strong | 9.83 | 9.842 |
| Small / Weak | 5.06 | 5.073 |
| Large / Weak | 2.74 | 2.754 |

No console errors or page errors; service worker active; JPEG download
produced. The screenshots and test report are kept in the research workspace
(`work/grain-web-test/`), not shipped in the deploy folder.

## Files

```
index.html            app shell and controls
styles.css            responsive dark UI
app.js                image pipeline, WebGL grain, PWA wiring
sw.js                 offline app-shell cache
manifest.json         install metadata
_headers              CSP/cache headers (Netlify, Cloudflare Pages)
netlify.toml          Netlify publish config
deploy/               host comparison and deploy scripts
icons/                PNG icons (any + maskable + Apple touch)
make_icons.py         icon generator
```

## Privacy

Images are decoded, processed and saved in the browser. Nothing is uploaded.
Settings stay in `localStorage`; the app shell is cached for offline use.

## Limits

- Applies grain to a **rendered image**, not to RAW data; it is not a RAW
  developer.
- HEIC decoding depends on the browser (Safari works; Chrome often does not).
  Use a JPEG export if the image fails to load.
- Default working resolution is 4096 px long edge. `Original` is bounded by the
  device's canvas and WebGL texture limits; use 2048 px on older phones.
- WebGL is required.
- Model parameters were measured at ISO 160, Provia, DR200; `Amount` is a
  creative multiplier, not an ISO/film-simulation simulation.
- The grain field is regenerated per render; it is statistically equivalent to
  the camera, not frame-identical.
