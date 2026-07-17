# RP-FixedImage

RP-FixedImage is an RP-Hub 1.7.3 based deployment that persists generated images in Cloudflare R2.

The first successful image request stores the original image in R2. The browser then converts that image to WebP and uploads the smaller copy. Later requests prefer the WebP copy and never return to the upstream image generator while either R2 copy exists.

## Features

- RP-Hub 1.7.3 hosted from the same Cloudflare Pages deployment.
- Image storage grouped by character name and UUID.
- Image filenames derived from SHA-256 of the complete normalized generation parameters.
- Original image storage:

  ```text
  RP-image/image/<character-name>--<character-uuid>/<sha256>
  ```

- Browser-produced WebP storage:

  ```text
  RP-image/Cache/<character-name>--<character-uuid>/<sha256>.webp
  ```

- Image and backup management at `/rp-image`.
- NAI Key encrypted with AES-GCM before being stored in R2.
- Unencrypted, versioned browser snapshots for RP-Hub IndexedDB and localStorage.
- Snapshot chunks are SHA-256 verified before commit and restore.

## Cloudflare Deployment

Deploy this entire directory as a Cloudflare Pages project. `_worker.js` uses Pages Advanced Mode and serves the static RP-Hub assets through `env.ASSETS`.

Create an R2 bucket and bind it to the Pages project with this exact binding name:

```text
RP_IMAGE_R2
```

Configure these Worker secrets:

```text
RP_IMAGE_ADMIN_PASSWORD
RP_IMAGE_MASTER_KEY
```

Use a long, random `RP_IMAGE_MASTER_KEY`. Changing it after saving the NAI Key makes the existing encrypted Key unreadable; in that case, delete and save the NAI Key again.

After deployment:

1. Open `https://<your-domain>/rp-image`.
2. Sign in with `RP_IMAGE_ADMIN_PASSWORD`.
3. Open **Settings**, enter the NAI Key, test it, and save it.
4. Select a character in RP-Hub and enable automatic image generation.

The management login creates a 30-day HttpOnly, Secure, SameSite=Strict cookie scoped to `/rp-image`. Existing R2 image copies can be read without generating again. A cache miss requires a valid management session before the Worker calls the upstream generator.

## Image Flow

```text
RP-Hub image###prompt###
    -> /rp-image/api/render
    -> WebP exists: return WebP
    -> original exists: return original
    -> neither exists: call NAI, store original, return original
    -> browser bridge converts to WebP and uploads it
    -> later requests return WebP
```

Original and first-generation responses use `Cache-Control: no-store` so the browser checks again on the next page load and can switch to WebP. Stored WebP responses use a one-hour revalidating cache so management deletion is observable without waiting a year.

## Browser Backups

The backup page reads same-origin data from:

```text
RPHubDB/store
AICharGen/characters
SillyTavernDB/store (when present)
rp_hub_*
ai_chargen_*
silly_tavern_*
```

Backups are stored under:

```text
RP-image/save/<site-name>--<origin-sha256>/<timestamp>/
```

Backups are intentionally **not encrypted**. They can contain chat history, role data, memories, and API Keys. Use a private R2 bucket and restrict access to the Cloudflare account.

Restoring a backup replaces the whitelisted browser data. The management page asks RP-Hub to flush and pause persistence before restoration, then reloads the RP-Hub tab.

## Limits

- Original image: 64 MiB maximum.
- WebP copy: 32 MiB maximum.
- Backup chunk: 16 MiB Worker limit; the browser currently creates 8 MiB chunks.
- Backup: 1 GiB maximum, 256 chunks maximum.
- Backup retention: 1 to 30 versions per origin.
- The in-memory duplicate-generation lock is per Worker isolate. R2 remains the durable cache, but extremely concurrent first requests reaching different isolates can still call the upstream more than once.

## Development

The project has no build step. Syntax checks:

```text
node --check _worker.js
node --check assets/js/app.js
node --check rp-image/bridge.js
node --check rp-image/admin.js
```

## License

The RP-Hub base remains licensed under CC BY-NC 4.0. See `LICENSE`. Commercial use is not permitted without appropriate authorization from the original project author.
