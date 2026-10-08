import {
  gatewayLocation,
  isPieceCid,
  parseCid,
  pieceLocation,
  pickProviderBase,
  type FindResponse
} from "./resolve";

export interface Env {
  INDEXER_URL?: string;
  GATEWAY_URL?: string;
  CACHE_TTL_SECONDS?: string;
}

export interface Deps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put"> | null;
  waitUntil(p: Promise<unknown>): void;
}

const DEFAULT_INDEXER = "https://cid.contact";
const DEFAULT_GATEWAY = "https://inbrowser.link";
const DEFAULT_TTL = 300;
const INDEXER_TIMEOUT_MS = 3000;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveTtl(env: Env): number {
  const parsed = parseInt(env.CACHE_TTL_SECONDS ?? "", 10);
  return Number.isNaN(parsed) || parsed < 1 ? DEFAULT_TTL : parsed;
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

function isPlainObject(value: unknown): value is FindResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

async function lookupIndexer(
  deps: Deps,
  indexer: string,
  cid: string
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
    return textResponse(404, "no HTTP piece provider indexed", "public, max-age=60");
  }
  if (!res.ok) {
    return textResponse(502, "indexer unavailable", "no-store");
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return textResponse(502, "indexer unavailable", "no-store");
  }
  if (!isPlainObject(body)) {
    return textResponse(502, "indexer unavailable", "no-store");
  }
  return body;
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

  const gateway = trimTrailingSlash(env.GATEWAY_URL ?? DEFAULT_GATEWAY);
  if (!isPieceCid(cid)) {
    return respond(
      redirectResponse(gatewayLocation(gateway, cid), "public, max-age=86400")
    );
  }

  const key = new Request(new URL("/retrieve/" + cid.toString(), request.url), {
    method: "GET"
  });
  if (deps.cache !== null) {
    const hit = await deps.cache.match(key);
    if (hit !== undefined) {
      return respond(hit);
    }
  }

  const indexer = trimTrailingSlash(env.INDEXER_URL ?? DEFAULT_INDEXER);
  const lookedUp = await lookupIndexer(deps, indexer, cid.toString());
  if (lookedUp instanceof Response) {
    const resp = lookedUp;
    if (deps.cache !== null && resp.status === 404) {
      deps.waitUntil(deps.cache.put(key, resp.clone()));
    }
    return respond(resp);
  }

  const ttl = resolveTtl(env);
  const base = pickProviderBase(lookedUp);
  const resp =
    base === null
      ? textResponse(404, "no HTTP piece provider indexed", "public, max-age=60")
      : redirectResponse(pieceLocation(base, cid), `public, max-age=${ttl}`);

  if (deps.cache !== null) {
    deps.waitUntil(deps.cache.put(key, resp.clone()));
  }
  return respond(resp);
}
