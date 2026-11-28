# GRAIN — X-T4 film grain (PWA)

An installable, offline photo editor that adds the measured X-T4 film-grain
effect to photos. It runs entirely in the browser: no uploads, no account.

## Features

- **Full-screen viewer**: the image fills the screen. Pinch or scroll to zoom,
  drag to pan, double-tap or `Fit` to reset.
- **Quick compare**: a floating eye button toggles the original without leaving
  the image.
- **Compact tool tray**: `Size`, `Strength`, `Amount`, `Film`, and `More`; each
  opens a small popover sheet so the image stays visible.
- **Top actions**: camera, photos, and save.
- **Live camera or library**: `Camera` opens an in-app live preview with a
  shutter, lens picker, zoom presets, and gallery shortcut; `Photos` opens the
  photo picker. On browsers that support `getUserMedia`, there is no native
  "Use Photo" step.
- **Local processing**: WebGL shader, no server.
- **Rotate**: rotate the working image 90° clockwise from `More`.
- **Installable PWA**: Android install prompt; iOS Add to Home Screen.
- **Offline**: the app shell is cached by a service worker.
- **Persistent settings**: size, strength, film, amount, seed, tone, resolution
  and format are stored in `localStorage`.

## Viewer

The photo is the main surface. Pinch or use the mouse wheel to zoom from 1× to
8×, drag to pan, double-tap to reset, or tap the fit button. The eye button
switches between the grain and the original. The bottom tray always shows the
current size, strength, amount, and film; tapping a tool opens a compact sheet
above it. `More` contains seed, tone response, resolution, save format, rotate,
install, and reset.

## Camera

`Camera` requests the rear camera with `getUserMedia` and shows a full-screen
live preview. The shutter captures the current video frame, closes the camera,
and loads the photo into the editor. The `Lens` chip lists the cameras the
browser exposes (front/rear and any extra lenses); the zoom presets above the
shutter and pinch-to-zoom control the field of view. The photo button opens the
library. The camera header shows the live resolution and zoom.

- Requires **HTTPS** (or localhost) and camera permission.
- Live capture uses the browser's video track. Resolution is shown in the
  header; it is often 1080p, and 4K where the browser and camera provide it.
  Use `Photos` when you need the phone's full-resolution still image.
- Hardware zoom is used when the browser exposes it; otherwise zoom is a
  digital center crop. A 2× digital capture has half the linear resolution.
- iOS Safari may expose only the front and rear cameras. Ultra-wide and
  telephoto lenses are not selectable through the web API on those versions.
- The preview fills the screen; the captured photo contains the full video
  frame, so it can include a little more at the edges than the preview.
- If `getUserMedia` is unavailable, permission is denied, or the camera is busy,
  the app shows `Try again`, `Phone camera` (native capture fallback), and
  `Photos` actions.
- `Rotate` in the editor rotates the working image 90° clockwise. Use it if a
  browser/device reports video orientation differently than the preview.

## Grain model

Corrected from uncompressed X-T4 RAF conversions (firmware 2.12; ISO 400,
Provia, DR100):

| Size | Strength | Std (8-bit) | Source | Kernel |
| --- | --- | ---: | --- | --- |
| Small | Weak | 8.25 | triangular | -0.06, 0.107, 1, 0.107, -0.06 |
| Small | Strong | 17.05 | triangular | -0.06, 0.107, 1, 0.107, -0.06 |
| Large | Weak | 4.02 | Gaussian | 0, 0.79, 1, 0.79, 0 |
| Large | Strong | 8.45 | Gaussian | 0, 0.79, 1, 0.79, 0 |

Small is a separable 5-tap band-pass; Large is a separable 3-tap low-pass.
Strong is about 2.07× Weak, and Small is about 2.04× Large in RMS. The same
monochrome field is added to R/G/B and clipped to 0–255.

The amplitude follows the measured output-luma curve: zero at black, flat
through the midtones, and rolling off toward highlight clipping. The `Camera
tone response` switch applies that curve; turn it off for a uniform-amplitude
creative variant.

`Acros` uses the B&W/Acros grain path: 0.86× amplitude and a tighter Large
kernel (0.05, 0.42, 1, 0.42, 0.05). Color simulations measured flat; other B&W
variants are assumed to share the Acros path.

`Amount` scales the measured amplitude; 100% is the measured baseline (so the
slider thumb sits at the midpoint of 0–200%). The rendered amplitude at luma
134 is about 0.969× the target because the measured tone curve is applied.

An earlier synthetic RAF (compressed X-T4 CFA plus an X-T30 header, black point
4096) mis-scaled the tone and produced the old white-Small / 5.0-amplitude
model. It is superseded by the uncompressed-X-T4 calibration above.

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

A headless Chromium + SwiftShader test loaded a neutral luma-134 flat field,
measured the rendered grain against the amount-0 reference, and exercised the
controls, compare overlay, save/download, service worker and manifest. The
target is the measured camera std; the rendered value includes the tone curve
at luma 134 (0.969×).

| Setting | Target std | Rendered std |
| --- | ---: | ---: |
| Large / Strong | 8.45 | 8.218 |
| Small / Strong | 17.05 | 16.487 |
| Small / Weak | 8.25 | 7.982 |
| Large / Weak | 4.02 | 3.918 |
| Large / Strong / Acros | 7.27 | 7.069 |
| Large / Strong, tone off | 8.45 | 8.481 |

Tone-curve bands, Large/Strong:

| Luma | Expected std | Rendered std |
| ---: | ---: | ---: |
| 0 (black) | 0 | 0 |
| 134 (calibration) | 8.19 | 8.21 |
| 220 (light) | 6.44 | 6.47 |
| 255 (white) | 0.25 pre-clip | 0.16 |

All amplitude and tone checks are within 6% of the model. No console errors or
page errors; service worker active; JPEG download produced. The screenshots and
test report are kept in the research workspace (`work/grain-web-test/`), not
shipped in the deploy folder.

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
- Live camera capture uses the browser's video track, not the camera's native
  still pipeline. Use `Photos` for full-resolution stills. Camera access needs
  HTTPS and permission; the native capture fallback still shows the phone's
  own "Use Photo" step.
- Video orientation differs between browsers and devices. The app rotates
  iOS landscape video frames to match the device orientation and provides a
  `Rotate` button for any remaining mismatch.
- HEIC decoding depends on the browser (Safari works; Chrome often does not).
  Use a JPEG export if the image fails to load.
- Default working resolution is **Original** (the full decoded image, capped by
  the device's canvas/WebGL texture limit). Use 2048 px on older phones if the
  full size is slow.
- WebGL is required.
- The corrected calibration is **ISO 400, Provia, DR100**. ISO 400–1250 measured
  flat; outside that range untested. Color film simulations measured flat;
  Acros/B&W is 0.86× with a tighter Large kernel. Other B&W variants are assumed
  to share that path.
- The tone curve was tabulated from the Strong/Large step wedge and is assumed
  to scale for the other size/strength combinations.
- The model is statistically equivalent to the camera, not frame-identical:
  the camera regenerates the field per conversion, and the exact PRNG, seed and
  coefficient bytes are not recoverable from the output. The Large kernel is a
  3-tap approximation; the camera has a small negative autocorrelation tail at
  lags 4–5, likely JPEG.
- `Amount` is a creative multiplier, not an ISO or film-simulation simulation.
