# Wabdav-2022

[English](README.md) | [中文](README.zh-CN.md)

A trimmed-down, self-hosted file drive on **Cloudflare Pages** (backend = Pages Functions, storage = **Cloudflare R2**), with a **WebDAV** endpoint built in.

It is a fork of [Davflare](https://github.com/lanshatop/Davflare) reduced to two things and one access model:

- **File management** — browse, upload, create folders, rename, move, delete, search, preview, recycle bin.
- **WebDAV** — mount the same bucket as a network drive / sync target (Obsidian, rclone, Windows Explorer, …).
- **Read is anonymous, writes need a password.** Anyone with the link can browse and download; anything that changes data sits behind a single admin password.

## Access model

| Operation | Anonymous visitor | Password holder |
| --- | --- | --- |
| Browse / search / download / zip a folder | ✅ | ✅ |
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

## Deploy to Cloudflare Pages

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

### Command-line deploy

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

Local credentials live in `.dev.vars` (git-ignored, local-only, not a deployment secret).

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
functions/        Cloudflare Pages Functions — the whole backend
  _middleware.ts    security headers, internal-prefix blocking, probe paths
  api/              JSON API (list, stat, download, archive, upload, mkdir, rename, delete, trash, search, auth, branding)
  webdav/           WebDAV protocol implementation + listing page
src/              React front end
branding/         site name / logo / icon configuration
tools/            local preview server, smoke test, branding build script
public/           static assets and response headers
```

## Acknowledgments

- [longern/FlareDrive](https://github.com/longern/FlareDrive) by [longern](https://github.com/longern) — the original project this line of forks descends from. The internal object prefix is still `_$flaredrive$/`.
- [lanshatop/Davflare](https://github.com/lanshatop/Davflare) — the full-featured rewrite this fork was trimmed from.
- [r2-webdav](https://github.com/abersheeran/r2-webdav) by [abersheeran](https://github.com/abersheeran) — WebDAV implementation reference.

## License

[MIT](./LICENSE) — the original copyright notice is retained.
