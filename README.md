# sd-ytodb

[English](README.md) | [中文](README.zh-CN.md)

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy%20to%20Cloudflare%20Pages-Actions-2563EB?logo=cloudflare&logoColor=white)](https://github.com/SDYTO/sd-ytodb/actions/workflows/deploy-cloudflare-pages.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

A trimmed-down, self-hosted file drive on **Cloudflare Pages** (backend = Pages Functions, storage = **Cloudflare R2**), with a **WebDAV** endpoint built in.

It is a fork of [Davflare](https://github.com/lanshatop/Davflare) reduced to two things and one access model:

- **File management** — browse, upload, create folders, rename, move, delete, search, preview, recycle bin.
- **WebDAV** — mount the same bucket as a network drive / sync target (Obsidian, rclone, Windows Explorer, …).
- **The web UI requires sign-in; WebDAV reads stay open.** The main site renders nothing but the login screen until the admin signs in (no app shell, no data requests). WebDAV reads remain anonymous for sharing, and everything that changes data sits behind a single admin password.

## Access model

| Operation | Anonymous visitor | Password holder |
| --- | --- | --- |
| Web UI (main site) | ❌ login screen only | ✅ |
| WebDAV read (`OPTIONS` / `PROPFIND` / `GET`) | ✅ | ✅ |
| Upload / new folder / rename / move | ❌ 401 | ✅ |
| Delete / recycle bin / restore / empty | ❌ 401 | ✅ |
| WebDAV write (`PUT` / `MKCOL` / `DELETE` / chunked upload) | ❌ 401 | ✅ |

The intent is a **share-by-link** drive: hand the URL to anyone, keep the write password to yourself. See [SECURITY.md](SECURITY.md) for the isolation details and the known boundaries.

## Features

- Grid / list views, breadcrumb navigation, multi-select, keyboard shortcuts, drag-and-drop upload, paste-to-upload, transfer manager
- Chunked uploads (files over 100 MB go through a multipart flow), lazy thumbnails for images uploaded by other clients
- Inline preview for images / video / audio / PDF / text
- Recycle bin with configurable retention (`TRASH_RETENTION_DAYS`), items restored from the UI
- Folder zip download
- WebDAV Class 1/2 at `/webdav` (own server-rendered listing page, no JavaScript required)
- UI branding from the interface: site name, logo, favicon, PWA icon — no redeploy needed
- Light / dark theme, Chinese / English UI

## What this fork removed

Everything that was not file management or WebDAV is gone, together with its backend endpoints, front-end views and environment variables: API-key issuing, the MCP playground, the extension drive, the CLI, static-site / image hosting, TextPad, share links, and the collect form.

> The principle: **every endpoint that does not exist is a vulnerability that does not exist.**

## One-click deploy

### Option 1 — one click on GitHub (recommended)

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy%20to%20Cloudflare%20Pages-Actions-2563EB?logo=cloudflare&logoColor=white)](https://github.com/SDYTO/sd-ytodb/actions/workflows/deploy-cloudflare-pages.yml)

**Everyday updates**: push to `main` and the workflow builds and deploys automatically.

**Manual deploy**: click the button → **Run workflow** on the right → fill in a couple of fields → everything else is automatic:

- creates the R2 bucket if it does not exist
- creates the Pages project if it does not exist
- stores the write password as an encrypted Pages secret
- builds and deploys, then writes the URL into the run summary

**Before the first run**, add these repository secrets under `Settings → Secrets and variables → Actions`:

| Secret | Required | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | Create a custom token at [API tokens](https://dash.cloudflare.com/profile/api-tokens) with at least `Cloudflare Pages: Edit`; add `Workers R2 Storage: Edit` if you want the workflow to create the bucket |
| `CLOUDFLARE_ACCOUNT_ID` | recommended | Your Cloudflare account ID. Can be left empty when the token only sees one account |
| `ADMIN_PASSWORD` | recommended | The write password, ideally 20+ random characters. Deployment still succeeds without it, but every write returns 503 (anonymous browsing is unaffected) |

> **The value of the `ADMIN_PASSWORD` secret *is* the live password.**
> Change it and you must **re-run this workflow** for it to take effect (Pages secrets are
> shipped with a new deployment). The final "post-deploy verification" step logs in with that
> secret for real, so a mismatch turns the run red instead of silently shipping a site nobody
> can log into.

> **Why not Cloudflare's own "Deploy to Cloudflare" button?**
> Because it **only supports Workers, not Pages**. The official docs, under Limitations,
> state: *"Pages applications: Deploy to Cloudflare buttons only support Workers applications."*
> This project is Pages + Pages Functions, so GitHub Actions serves as the equivalent
> one-click entry point — and it does more: the official button will not create your
> bucket, your project or your secret.

### Option 2 — one command locally

```bash
export CLOUDFLARE_API_TOKEN=your-token     # Windows PowerShell: $env:CLOUDFLARE_API_TOKEN="..."
npm run deploy
```

The script walks through the R2 bucket, the Pages project and the write password, then builds and deploys. Every step is idempotent, so re-running is safe. To see what it would do without doing it:

```bash
npm run deploy:dry
```

No token is needed if you have already run `npx wrangler login` on this machine — the script reuses that session. See `npm run deploy -- --help` for all options.

### Option 3 — Cloudflare dashboard Git integration

Cloudflare dashboard → Workers & Pages → Create → Pages → **Connect to Git** → pick this repository. Build command `npm run build`, output directory `build`, then bind your R2 bucket to the variable name `BUCKET`. Every push to the production branch then redeploys automatically.

## Manual deployment

1. Activate R2 in your Cloudflare account, then create a bucket (name must be lowercase letters / digits / hyphens).
2. Create a Pages project and point it at this repository. Framework preset **None**, build command `npm run build`, output directory `build` (this is also what `wrangler.toml` declares via `pages_build_output_dir`).
3. Bind your R2 bucket to the variable name **`BUCKET`**.
4. Set the environment variables:

   | Variable | Kind | Default | Meaning |
   | --- | --- | --- | --- |
   | `ADMIN_USER` | plain | `admin` | Username for write operations |
   | `ADMIN_PASSWORD` | **secret** | — | Password for write operations. **If it is missing, every write returns 503** (fail-closed, never "anyone can write") |
   | `TRASH_RETENTION_DAYS` | plain | `30` | Days before a trashed object is dropped. `-1` disables cleanup |

   ```bash
   npx wrangler pages secret put ADMIN_PASSWORD --project-name <your-pages-project>
   ```

5. Optionally add a custom domain.

> **`name` and `bucket_name` in `wrangler.toml`.** This repository ships the values used by the original author's own deployment, so that a redeploy keeps working. Change both to your own project name and bucket name before deploying to your account.

> **Keep the R2 bucket private.** It must only be reached through the Pages binding. Enabling the bucket's public development URL or a custom domain bypasses all of the authentication logic above.

The fully manual command-line equivalent:

```bash
npm install
npm run build
npx wrangler pages deploy build --project-name <your-pages-project> --branch main
```

## Local preview

`wrangler pages dev` needs a working `workerd`; if that is unavailable on your machine, this repository ships a Node-based stand-in that reproduces the Pages routing rules and runs the real `functions/` code against a filesystem-backed R2 mock.

```bash
npm install
npm run preview        # http://127.0.0.1:8788
npm run preview:reset  # same, but start from an empty bucket
npm run smoke          # end-to-end smoke test against the running preview
```

`npm run smoke` asserts the whole access model — anonymous reads, writes rejected without a password, the internal metadata prefix being unreachable through the URL / API / WebDAV layers, path-traversal rejection, recycle-bin round-trips, chunked uploads, and the branding endpoints.

Local credentials live in `.dev.vars` (git-ignored, local-only, not a deployment secret) — copy `.dev.vars.example` to get started.

## WebDAV

| | |
| --- | --- |
| URL | `https://<your-domain>/webdav/` |
| Read-only mount | no credentials needed |
| Read-write mount | username `ADMIN_USER`, password `ADMIN_PASSWORD` |

Windows (map a network drive):

```
net use W: https://<your-domain>/webdav/ /user:admin <password>
```

Opening `/webdav/` in a browser renders a server-side listing page — useful for handing out a plain, script-free view of a folder.

## Custom branding

Two ways, pick either:

1. **From the interface (no redeploy).** Sign in as admin → account menu → **Branding settings**. Change the site name, then upload a logo, a favicon and a home-screen icon (with preview). Saving applies immediately to the header, the browser tab, the login dialog, the PWA manifest and the WebDAV listing page. "Restore defaults" reverts to the build-time configuration.
2. **From the config file (becomes the default for new deployments).** Edit `branding/config.json` and drop your artwork next to it, then rebuild. See [branding/README.md](branding/README.md) for the field reference and image specs.

Either way, uploaded artwork is format-sniffed by content (never by extension), capped at 1 MB (256 KB for SVG), and SVGs are sanitised on upload and served under `Content-Security-Policy: sandbox`.

> The bundled `public/favicon.png` and `public/logo144.png` are placeholders from the upstream project. Replace them with your own before publishing a site.

## Project layout

```
.github/workflows/  GitHub Actions — the one-click deploy workflow
functions/        Cloudflare Pages Functions — the whole backend
  _middleware.ts    security headers, internal-prefix blocking, probe paths
  api/              JSON API (list, stat, download, archive, upload, mkdir, rename, delete, trash, search, auth, branding)
  webdav/           WebDAV protocol implementation + listing page
src/              React front end
branding/         site name / logo / icon configuration
tools/            local preview server, smoke test, branding build script, one-click deploy script
public/           static assets and response headers
```

## Acknowledgments

- [longern/FlareDrive](https://github.com/longern/FlareDrive) by [longern](https://github.com/longern) — the original project this line of forks descends from. The internal object prefix is still `_$flaredrive$/`.
- [lanshatop/Davflare](https://github.com/lanshatop/Davflare) — the full-featured rewrite this fork was trimmed from.
- [r2-webdav](https://github.com/abersheeran/r2-webdav) by [abersheeran](https://github.com/abersheeran) — WebDAV implementation reference.

## License

[MIT](./LICENSE) — the original copyright notice is retained.
