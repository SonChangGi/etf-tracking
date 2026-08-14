# ETF Tracking shared frontend integration

## Decision

ETF Tracking stays a static GitHub Pages application. Its public controls do
not request a new Python analysis:

- ETF, observation date, and date range select already published results.
- Chart emphasis, table filters, sorting, pagination, disclosures, and theme
  change only the presentation.
- Refresh and backfill remain authenticated owner operations in GitHub Actions.

FastAPI is therefore not part of this page. Adding a run API here would make
display controls look like analysis inputs without improving the source-of-truth
Python collector. `scripts/update_data.py`, the generated JSON contracts, and
`.github/workflows/update-data.yml` are unchanged.

## Independently buildable compatibility seam

`shared-platform/` is a pinned, dependency-free compatibility seam for
`quant-platform-frontend/0.1.0`. It is deliberately not a `file:` dependency,
worktree import, CDN, or cross-origin runtime:

- `src/index.js` contains the four control kinds, ETF control manifest,
  canonical 8-destination registry, semantic token names, and static adapters.
- `dist/index.js` is a byte-identical, same-origin browser build.
- `platform-snapshot.json` records upstream source hashes, the vendored file
  hash, and one aggregate fingerprint.
- `scripts/build.mjs` and `scripts/verify-snapshot.mjs` make the seam
  independently buildable and reproducible.

When the shared Hub packages are published, this seam can be replaced by a
versioned package without changing ETF data, Python, charts, tables, or URLs.

## Control contract

Every interactive element is annotated with a control id registered in
`etfControlManifest`.

- `display`: theme, navigation, chart emphasis, table search/filter/sort,
  pagination, lazy loading, disclosures, and source/status links.
- `result_selector`: ETF, observation date, start/end date, and range preset.
- `operation`: only `owner_refresh_backfill`, which requires GitHub
  authentication.
- `analysis`: none.

The browser runtime contains no `POST`, analysis configuration submission, or
`/runs` endpoint. Opening Actions or copying its CLI command does not claim that
the public page recalculated a result.

## Static result and failure boundary

`etf-static-result/v1` loads these small files together with same-origin
`GET`/`no-store` requests:

1. `data/dashboard.json`
2. `data/status.json`
3. `data/history.json`
4. `data/automation-status.json`

The adapter accepts the snapshot only after checking schema major,
`generatedAt`, ETF identities, history URLs/counts/ranges, latest dates, and
status identities. It passes the original payload objects through without
recalculation, value replacement, sorting, or fallback data.

Each large per-ETF history remains under `data/history/*.json` and loads only
when needed. Its schema, `generatedAt`, ETF id, row count, order, date range,
and latest date must match the accepted small snapshot. A malformed or mixed
snapshot is rejected and shown as unavailable; the page never labels embedded
sample data as a calculated result.

A degraded but internally consistent publication remains visible with its
saved data date and automation state. A newer refresh target is not confused
with the older verified result date.

## Static build and byte parity

`npm run build` creates `dist/` as a standalone static Pages artifact:

- HTML, CSS, application JavaScript, and the local compatibility runtime are
  copied without external runtime dependencies.
- All ETF JSON files remain separate static files.
- `scripts/verify-build.mjs` compares every source and built JSON file by
  SHA-256 and rejects any byte difference.
- The verifier also rejects a client bundle large enough to suggest that ETF
  histories were embedded in JavaScript.

## Sync procedure

When the shared platform version changes:

1. Compare the upstream contract, project registry, and UI token hashes in
   `shared-platform/platform-snapshot.json`.
2. Update only compatible code in `shared-platform/src/index.js`.
3. Rebuild `shared-platform/dist/index.js`.
4. Update the source hash and aggregate fingerprint.
5. Run `npm test`.
6. Review desktop and 390 px layouts in light and dark mode before release.

Do not move ETF history into Supabase, a frontend bundle, or another
repository's runtime. GitHub Pages static JSON remains the public result source
until a separately reviewed data-migration project proves byte-level parity and
preserves the current URL contract.
