# Deployment options

The app is a static folder with no build step. It must be served over **HTTPS**
for the service worker and PWA install. `_headers` is understood by Netlify
and Cloudflare Pages; GitHub Pages ignores it.

| Host | Deploy | Free tier | Custom headers | Best for |
| --- | --- | --- | --- | --- |
| **Cloudflare Pages** | Git or `wrangler` direct upload | Unlimited requests/bandwidth, 500 builds/month | Yes (`_headers`) | Best default: global CDN, no bandwidth ceiling |
| **Netlify** | Drag/drop, CLI, Git | 100 GB bandwidth/month, 300 build minutes/month | Yes (`_headers`) | Fastest zero-config deploy |
| **GitHub Pages** | Git + Actions | 1 GB site, 100 GB/month soft; public repo on Free | No | Zero extra account if source is on GitHub |
| **Vercel** | Git/CLI | 100 GB/month Hobby; **Hobby is non-commercial** | Yes (`vercel.json`) | Next.js projects; use Pro if commercial |
| **Firebase Hosting** | CLI/Action | 10 GB storage, 360 MB/day transfer (Spark) | Yes (`firebase.json`) | Existing Firebase projects |
| **S3 + CloudFront** | CLI/API | Pay-as-you-go | Yes | Full control; more setup |

## Recommendation

- **Cloudflare Pages** for the best free static host: unlimited bandwidth,
  global CDN, `_headers` support, Git or direct upload.
- **Netlify** for the quickest deploy: drag the zip onto Netlify Drop or run one
  command.
- **GitHub Pages** if the app will live in a public GitHub repo and you want no
  extra account. It has no custom headers and a public repo is required on the
  free plan.

For a personal photo tool, Netlify or Cloudflare Pages is the better long-term
home. GitHub Pages is convenient but public and cannot set the CSP or
`no-cache` headers.

## Netlify

One command (first run opens a browser login, or set `NETLIFY_AUTH_TOKEN`):

```sh
./deploy/netlify.sh
```

Or build a zip and drag it to <https://app.netlify.com/drop>:

```sh
./deploy/zip.sh
```

`netlify.toml` sets the publish directory to `.`; `_headers` supplies CSP and
cache headers. First deploy creates/links a site; later deploys use `--prod`.

## Cloudflare Pages

```sh
./deploy/cloudflare.sh
```

First run opens `wrangler login`, or set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`. The project name defaults to `xt4-grain`; change it in
`deploy/cloudflare.sh` if it is taken.

Dashboard alternative: create a Pages project, connect the repo, leave the
build command empty, and set the output directory to `/` (the app root).
`_headers` is read from the output directory.

## GitHub Pages

GitHub Pages needs the app in its own repository, at the root (or adjust
`path:` in the workflow). Do **not** run this from the research repo directly;
copy the app first:

```sh
cp -a work/grain-web /tmp/grain-pwa
cd /tmp/grain-pwa
git init -b main
git add .
git commit -m "GRAIN PWA"

gh repo create <user>/grain --public --source . --push
mkdir -p .github/workflows
cp deploy/github-pages.yml .github/workflows/pages.yml
git add .github && git commit -m "Add Pages workflow" && git push
```

Then enable Pages → **GitHub Actions** in the repository settings, or:

```sh
gh api -X POST repos/<user>/grain/pages -f build_type=workflow
```

The site is `https://<user>.github.io/grain/`. Relative paths and the service
worker scope work under that subpath. `.nojekyll` is included so GitHub does
not run Jekyll.

Caveats:

- **Public repo** on the free plan (private Pages requires a paid plan).
- `_headers` is ignored: no custom CSP and no `no-cache` for `sw.js`. GitHub
  may cache `sw.js` for a short time, so updates can lag; the app's cache
  version handles the shell.
- `manifest.json` is served as JSON, which browsers accept for the manifest.

## Vercel

Vercel Hobby is for non-commercial use. If that fits, add a `vercel.json`
headers block and run `npx vercel --prod`; otherwise use Netlify or Cloudflare.

## Firebase / S3

Both work but require more setup (project/bucket, CDN, headers). Use them only
if you already have that infrastructure; the static app needs nothing beyond
HTTPS and the `_headers` equivalents.
