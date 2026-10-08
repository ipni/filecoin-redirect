# filecoin-redirect

A redirect-only router on Cloudflare Pages. Given a CID it never proxies or fetches content; every response is one redirect or an error. `GET /retrieve/{cid}`: a PieceCID v2 is looked up on cid.contact and redirected to a storage provider's `/piece/{cid}`; any other CID is redirected, with no lookup, to a gateway that finds providers itself.

## Contract

- PieceCID v2 (`bafkzcib...`, CIDv1 with raw codec and multihash code 0x1011): cid.contact lookup, 302 to the first provider advertising `filecoin-piece-http` (0x0930) with an https address; cached for `CACHE_TTL_SECONDS`.
- Any other valid CID (payload CID): no lookup, 302 to `${GATEWAY_URL}/ipfs/{cid}`, cached with max-age 86400.
- No HTTP piece provider indexed: 404, cached 60s. Indexer failure: 502, not cached. Non-CID input: 400. Accepted CIDs are written in base32, base36 or base58btc (CIDv0 `Qm...`); anything else, including other multibase encodings, gets 400.
- `Access-Control-Allow-Origin: *` on every response.
- A piece is the exact bytes the client uploaded, served with a sniffed content type, so a raw file (image, PDF, video) renders in the browser and a CAR upload downloads as a CAR. Payload CIDs render through inbrowser.link, which finds providers itself via delegated routing.
- Browser `fetch()` works against the piece path: the public HTTP API sends wildcard CORS. The gateway path does not: inbrowser.link's redirect carries no CORS headers and its subdomain serves a service-worker bootstrap page, so `fetch()` of a payload CID does not return the bytes.

## Examples

```sh
curl -sI https://<project>.pages.dev/retrieve/<pieceCidV2>
curl -sI https://<project>.pages.dev/retrieve/<payloadCid>
```

## Configuration

Edit `[vars]` in `wrangler.toml`; with `pages_build_output_dir` set, that file is the source of truth for configuration and the dashboard shows the same fields read-only.

- `INDEXER_URL` (default `https://cid.contact`)
- `GATEWAY_URL` (default `https://inbrowser.link`)
- `CACHE_TTL_SECONDS` (default `300`)

## Local development

```sh
npm ci
npm test
npm run typecheck
npx wrangler pages dev   # foreground; serves http://localhost:8788
scripts/smoke.sh http://localhost:8788 <cid>...
```

## Deploy

Connect the repo to Cloudflare Pages in the dashboard (Pages Git integration). No build command is needed; the output directory is read from `wrangler.toml`. Each push to `main` installs dependencies, builds `functions/` and serves `public/`.

## Known limitations

- PieceCID v1 (`baga6ea4...`, v1 piece multihash) is not indexed by Curio PDP and is not a v2 piece, so it falls to the gateway path and will not resolve there.
- No fallback if the chosen provider is down; the router does not verify provider liveness.
- `https://inbrowser.link/ipfs/<cid>` answers a 301 to its `<cid>.ipfs.inbrowser.link` subdomain for a browser User-Agent and 403 for curl's default User-Agent.

## Out of scope

- Provider preference or ordering beyond the first https advertiser
- Geo-based selection
- Retries or liveness checks
- Piece-to-payload mapping
- Logging or dashboards
