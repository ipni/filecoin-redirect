# filecoin-redirect

A redirect-only router on Cloudflare Pages. Given a CID it never proxies or fetches content; every response is one redirect or an error. `GET /retrieve/{cid}`: every valid CID is looked up on cid.contact and redirected straight to a provider: a PieceCID v2 to its `/piece/` endpoint, any other CID to its trustless gateway at `/ipfs/`.

## Contract

- PieceCID v2 (`bafkzcib...`, CIDv1 with raw codec and multihash code 0x1011): cid.contact lookup, 302 to `{provider}/piece/{cid}` for the first provider advertising `filecoin-piece-http` (0x0930) with an https address; cached for `CACHE_TTL_SECONDS` (default 300; digits only, 1 to 86400, larger values clamped to 86400; anything else, including 0, gives 300).
- Every other valid CID (payload CID): cid.contact lookup, 302 to `{provider}/ipfs/{cid}?format=car` for the first provider advertising gateway-http (0x0920) with an https address; same cache TTL.
- No matching provider: 404, `public, max-age=60`, body `no HTTP piece provider indexed` (piece) or `no HTTP gateway provider indexed` (payload). Indexer failure or timeout: 502, not cached.
- Accepted CIDs are written in base32, base36 or base58btc (CIDv0 `Qm...`); anything else, including other multibase encodings, gets 400.
- Provider URLs are filtered: only public-looking DNS names are accepted (no IP literals, localhost or private-looking names). The filter looks at the name only and cannot resolve DNS, so a public name that points at a private address (for example a `nip.io` or `sslip.io` name) is not caught. The first matching provider wins; there is no ranking, no liveness check and no fallback.
- `Access-Control-Allow-Origin: *` on every GET and HEAD response.
- The service never fetches, proxies, caches or verifies content; the provider is whoever announced the CID to IPNI, so clients should verify what they receive (a CAR carries its root CID).
- Payload CIDs download as CARs rather than render in a browser. Providers typically send wildcard CORS, so browser `fetch()` usually works (not guaranteed).

## Examples

```sh
curl -sI https://<project>.pages.dev/retrieve/<pieceCidV2>
curl -sI https://<project>.pages.dev/retrieve/<payloadCid>
```

## Configuration

Edit `[vars]` in `wrangler.toml`; with `pages_build_output_dir` set, that file is the source of truth for configuration and the dashboard shows the same fields read-only.

- `INDEXER_URL` (default `https://cid.contact`)
- `CACHE_TTL_SECONDS` (default `300`)

## Local development

```sh
npm ci
npm test
npm run typecheck
npx wrangler pages dev   # foreground; serves http://localhost:8788
scripts/smoke.sh http://localhost:8788 bafkreiauo4htqtbs55hyn6yt3og7zpvhfqoz4n2obstz6fn3j6nebbqg44 <pieceCidV2>
```

## Deploy

Connect the repo to Cloudflare Pages in the dashboard (Pages Git integration). Set the build command to `npm ci` in the project settings (it cannot be set in `wrangler.toml`); the output directory is read from `wrangler.toml`. Without a build command Pages skips the dependency install and the Functions build fails with `Could not resolve "multiformats/cid"`. Each push to `main` then installs dependencies, builds `functions/` and serves `public/`.

## Known limitations

- The first matching provider wins; there is no ranking, no liveness check and no fallback.
- Many CIDs (bitswap- or graphsync-only) have no gateway-http provider and return 404; a provider that announces graphsync together with gateway-http is not matched.
- PieceCID v1 (`baga6ea4...`) and other non-v2 CIDs are treated as payload CIDs and will usually 404.
- Identity-multihash CIDs (content inline in the CID, such as `bafkqaaa`) cost an indexer lookup and get a cached 404.
- Redirects cached by clients before this change may still point at the previous gateway for up to 24 hours.
- Piece CIDs return 404 until a provider announces filecoin-piece-http.

## Out of scope

- Liveness probes
- Fallback gateway
- Provider ranking
- Logging or dashboards
