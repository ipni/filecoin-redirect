import {
  asRecord,
  ipfsLocation,
  isPieceCid,
  parseCid,
  pieceLocation,
  pickGatewayBase,
  pickProviderBase,
  type FindResponse
} from "./resolve";

export interface Env {
  INDEXER_URL?: string;
  CACHE_TTL_SECONDS?: string;
}

export interface Deps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put"> | null;
  waitUntil(p: Promise<unknown>): void;
}

export type CidKind = "piece" | "payload";

const DEFAULT_INDEXER = "https://cid.contact";
const DEFAULT_TTL = 300;
const MAX_TTL = 86400;
const INDEXER_TIMEOUT_MS = 3000;
const TTL_RE = /^\d+$/;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function envSetting(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? fallback : trimmed;
}

function resolveTtl(env: Env): number {
  const value = envSetting(env.CACHE_TTL_SECONDS, "");
  if (!TTL_RE.test(value)) {
    return DEFAULT_TTL;
  }
  const parsed = Number(value);
  if (parsed < 1) {
    return DEFAULT_TTL;
  }
  return parsed > MAX_TTL ? MAX_TTL : parsed;
}

function textResponse(status: number, body: string, cacheControl: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function redirectResponse(location: string, cacheControl: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": cacheControl,
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function noProviderResponse(kind: CidKind): Response {
  const body =
    kind === "piece"
      ? "no HTTP piece provider indexed"
      : "no HTTP gateway provider indexed";
  return textResponse(404, body, "public, max-age=60");
}

async function lookupIndexer(
  deps: Deps,
  indexer: string,
  cid: string,
  kind: CidKind
): Promise<FindResponse | Response> {
  let res: Response;
  try {
    res = await deps.fetch(`${indexer}/cid/${cid}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS)
    });
  } catch {
    return textResponse(502, "indexer unavailable", "no-store");
  }

  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return noProviderResponse(kind);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return textResponse(502, "indexer unavailable", "no-store");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return textResponse(502, "indexer unavailable", "no-store");
  }
  const rec = asRecord(body);
  if (rec === null) {
    return textResponse(502, "indexer unavailable", "no-store");
  }
  return rec as FindResponse;
}

export async function handle(
  request: Request,
  cidParam: string,
  env: Env,
  deps: Deps
): Promise<Response> {
  const respond = (resp: Response): Response =>
    request.method === "HEAD" ? new Response(null, resp) : resp;

  const cid = parseCid(cidParam);
  if (cid === null) {
    return respond(textResponse(400, "not a CID", "no-store"));
  }

  const kind: CidKind = isPieceCid(cid) ? "piece" : "payload";

  const key = new Request(new URL("/retrieve/" + cid.toString(), request.url), {
    method: "GET"
  });
  if (deps.cache !== null) {
    const hit = await deps.cache.match(key).catch(() => undefined);
    if (hit !== undefined) {
      return respond(hit);
    }
  }

  const indexer = trimTrailingSlash(envSetting(env.INDEXER_URL, DEFAULT_INDEXER));
  const lookedUp = await lookupIndexer(deps, indexer, cid.toString(), kind);
  if (lookedUp instanceof Response) {
    const resp = lookedUp;
    if (deps.cache !== null && resp.status === 404) {
      deps.waitUntil(deps.cache.put(key, resp.clone()).catch(() => {}));
    }
    return respond(resp);
  }

  const ttl = resolveTtl(env);
  let base: string | null;
  try {
    base = kind === "piece" ? pickProviderBase(lookedUp) : pickGatewayBase(lookedUp);
  } catch {
    return respond(textResponse(502, "indexer unavailable", "no-store"));
  }
  const resp =
    base === null
      ? noProviderResponse(kind)
      : redirectResponse(
          kind === "piece" ? pieceLocation(base, cid) : ipfsLocation(base, cid),
          `public, max-age=${ttl}`
        );

  if (deps.cache !== null) {
    deps.waitUntil(deps.cache.put(key, resp.clone()).catch(() => {}));
  }
  return respond(resp);
}
