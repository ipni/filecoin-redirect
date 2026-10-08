import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { base36 } from "multiformats/bases/base36";
import { handle, type Deps } from "../src/handler";
import emptyFixture from "./fixtures/empty.json";
import gatewayOnlyFixture from "./fixtures/gateway-only.json";
import pieceHitFixture from "./fixtures/piece-hit.json";

const PIECE_CID = "bafkzcibcfab4grpgq6e6rva4kfuxfcvibdzx3kn2jdw6q3zqgwt5cou7j6k4wfq";
const PIECE_CID_BASE36 = CID.parse(PIECE_CID).toString(base36);
const IPFS_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CIDV0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

class FakeCache implements Pick<Cache, "match" | "put"> {
  readonly entries = new Map<string, Response>();
  putCount = 0;

  async match(request: Request): Promise<Response | undefined> {
    const hit = this.entries.get(request.url);
    return hit?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putCount++;
    this.entries.set(request.url, response.clone());
  }

  async delete(request: Request): Promise<boolean> {
    return this.entries.delete(request.url);
  }
}

interface StubOptions {
  response?: Response;
  body?: unknown;
  throws?: boolean;
}

function stubFetch(options: StubOptions = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (options.throws) {
      throw new Error("network down");
    }
    if (options.response) {
      return options.response;
    }
    return new Response(JSON.stringify(options.body ?? emptyFixture), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function makeDeps(
  fetchImpl: typeof fetch,
  cache: Pick<Cache, "match" | "put"> | null = null
): Deps & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    fetch: fetchImpl,
    cache,
    waitUntil: (p) => {
      pending.push(p);
    },
    pending
  };
}

async function flush(deps: Deps & { pending: Promise<unknown>[] }): Promise<void> {
  await Promise.all(deps.pending);
}

function get(url: string, method = "GET"): Request {
  return new Request(url, { method });
}

describe("payload CID path", () => {
  it("302s a bafy CID to the gateway with no fetch and no cache write", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl, calls } = stubFetch();
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + IPFS_CID),
      IPFS_CID,
      {},
      deps
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://inbrowser.link/ipfs/${IPFS_CID}`);
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(calls).toHaveLength(0);
    expect(cache.putCount).toBe(0);
  });

  it("302s a v0 CID to the gateway with no fetch", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl, calls } = stubFetch();
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + CIDV0),
      CIDV0,
      {},
      makeDeps(fetchImpl, cache)
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://inbrowser.link/ipfs/${CIDV0}`);
    expect(calls).toHaveLength(0);
    expect(cache.putCount).toBe(0);
  });

  it("honours a custom GATEWAY_URL with a trailing slash", async () => {
    const { fetch: fetchImpl } = stubFetch();
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + IPFS_CID),
      IPFS_CID,
      { GATEWAY_URL: "https://gw.example.com/" },
      makeDeps(fetchImpl)
    );
    expect(resp.headers.get("Location")).toBe(`https://gw.example.com/ipfs/${IPFS_CID}`);
  });
});

describe("piece CID path", () => {
  it("302s to the provider with piece-hit fixture and caches it", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl, calls } = stubFetch({ body: pieceHitFixture });
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      deps
    );
    await flush(deps);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://cid.contact/cid/${PIECE_CID}`);
    expect(cache.putCount).toBe(1);
  });

  it("serves a repeat call from cache with zero fetches", async () => {
    const cache = new FakeCache();
    const first = stubFetch({ body: pieceHitFixture });
    const firstDeps = makeDeps(first.fetch, cache);
    await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      firstDeps
    );
    await flush(firstDeps);

    const second = stubFetch({ throws: true });
    const secondDeps = makeDeps(second.fetch, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      secondDeps
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(second.calls).toHaveLength(0);
  });

  it("shares one cache key between base32 and base36 spellings", async () => {
    const cache = new FakeCache();
    const first = stubFetch({ body: pieceHitFixture });
    const firstDeps = makeDeps(first.fetch, cache);
    await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      firstDeps
    );
    await flush(firstDeps);

    const second = stubFetch({ throws: true });
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID_BASE36),
      PIECE_CID_BASE36,
      {},
      makeDeps(second.fetch, cache)
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect(second.calls).toHaveLength(0);
  });

  it("ignores the request query string for the key and the Location", async () => {
    const cache = new FakeCache();
    const first = stubFetch({ body: pieceHitFixture });
    const firstDeps = makeDeps(first.fetch, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID + "?filename=foo.car"),
      PIECE_CID,
      {},
      firstDeps
    );
    await flush(firstDeps);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect([...cache.entries.keys()]).toEqual([
      `https://redirect.example.com/retrieve/${PIECE_CID}`
    ]);

    const second = stubFetch({ throws: true });
    const again = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID + "?other=1"),
      PIECE_CID,
      {},
      makeDeps(second.fetch, cache)
    );
    expect(again.status).toBe(302);
    expect(second.calls).toHaveLength(0);
  });

  it("404s and caches when only gateway providers are indexed", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl } = stubFetch({ body: gatewayOnlyFixture });
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      deps
    );
    await flush(deps);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(resp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(cache.putCount).toBe(1);
  });

  it("404s and caches when the indexer 404s", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl } = stubFetch({
      response: new Response("not found", { status: 404 })
    });
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      deps
    );
    await flush(deps);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(cache.putCount).toBe(1);
  });

  it("502s without caching on indexer 500, a throwing fetch, or a null body", async () => {
    const cases: StubOptions[] = [
      { response: new Response("boom", { status: 500 }) },
      { throws: true },
      { response: new Response("null", { status: 200 }) }
    ];
    for (const options of cases) {
      const cache = new FakeCache();
      const { fetch: fetchImpl } = stubFetch(options);
      const deps = makeDeps(fetchImpl, cache);
      const resp = await handle(
        get("https://redirect.example.com/retrieve/" + PIECE_CID),
        PIECE_CID,
        {},
        deps
      );
      await flush(deps);
      expect(resp.status).toBe(502);
      expect(resp.headers.get("Cache-Control")).toBe("no-store");
      expect(cache.putCount).toBe(0);
    }
  });

  it("falls back to max-age=300 for an invalid TTL", async () => {
    const { fetch: fetchImpl } = stubFetch({ body: pieceHitFixture });
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      { CACHE_TTL_SECONDS: "not-a-number" },
      makeDeps(fetchImpl)
    );
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});

describe("errors and methods", () => {
  it("400s for a non-CID", async () => {
    const { fetch: fetchImpl, calls } = stubFetch();
    const resp = await handle(
      get("https://redirect.example.com/retrieve/notacid"),
      "notacid",
      {},
      makeDeps(fetchImpl)
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await resp.text()).toBe("not a CID");
    expect(calls).toHaveLength(0);
  });

  it("returns a null body for HEAD on the payload path, a piece hit and a piece miss", async () => {
    const payload = stubFetch();
    const payloadResp = await handle(
      get("https://redirect.example.com/retrieve/" + IPFS_CID, "HEAD"),
      IPFS_CID,
      {},
      makeDeps(payload.fetch)
    );
    expect(payloadResp.status).toBe(302);
    expect(payloadResp.body).toBeNull();
    expect(payloadResp.headers.get("Location")).toBe(`https://inbrowser.link/ipfs/${IPFS_CID}`);

    const cache = new FakeCache();
    const hitStub = stubFetch({ body: pieceHitFixture });
    const hitDeps = makeDeps(hitStub.fetch, cache);
    await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      hitDeps
    );
    await flush(hitDeps);
    const hitResp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID, "HEAD"),
      PIECE_CID,
      {},
      makeDeps(stubFetch({ throws: true }).fetch, cache)
    );
    expect(hitResp.status).toBe(302);
    expect(hitResp.body).toBeNull();
    expect(hitResp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);

    const missStub = stubFetch({ body: gatewayOnlyFixture });
    const missDeps = makeDeps(missStub.fetch, new FakeCache());
    const missResp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID, "HEAD"),
      PIECE_CID,
      {},
      missDeps
    );
    await flush(missDeps);
    expect(missResp.status).toBe(404);
    expect(missResp.body).toBeNull();
    expect(missResp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });
});

describe("malformed indexer bodies", () => {
  const bodies: unknown[] = [
    { MultihashResults: 5 },
    { MultihashResults: {} },
    { MultihashResults: [null] },
    { MultihashResults: [{ ProviderResults: [null] }] },
    {
      MultihashResults: [
        { ProviderResults: [{ Metadata: "sBIA", Provider: { Addrs: [5] } }] }
      ]
    }
  ];
  bodies.forEach((body, i) => {
    it(`never throws and 404s (cached) when nothing is usable (case ${i})`, async () => {
      const cache = new FakeCache();
      const { fetch: fetchImpl } = stubFetch({ body });
      const deps = makeDeps(fetchImpl, cache);
      const resp = await handle(
        get("https://redirect.example.com/retrieve/" + PIECE_CID),
        PIECE_CID,
        {},
        deps
      );
      await flush(deps);
      expect(resp.status).toBe(404);
      expect(resp.headers.get("Cache-Control")).toBe("public, max-age=60");
      expect(cache.putCount).toBe(1);
    });
  });
});

describe("blank env settings fall back to defaults", () => {
  for (const blank of ["", "   ", "\t"]) {
    it(`uses the default gateway for GATEWAY_URL ${JSON.stringify(blank)}`, async () => {
      const { fetch: fetchImpl } = stubFetch();
      const resp = await handle(
        get("https://redirect.example.com/retrieve/" + IPFS_CID),
        IPFS_CID,
        { GATEWAY_URL: blank },
        makeDeps(fetchImpl)
      );
      expect(resp.headers.get("Location")).toBe(
        `https://inbrowser.link/ipfs/${IPFS_CID}`
      );
    });

    it(`uses the default indexer for INDEXER_URL ${JSON.stringify(blank)}`, async () => {
      const { fetch: fetchImpl, calls } = stubFetch({ body: pieceHitFixture });
      const resp = await handle(
        get("https://redirect.example.com/retrieve/" + PIECE_CID),
        PIECE_CID,
        { INDEXER_URL: blank },
        makeDeps(fetchImpl)
      );
      expect(resp.status).toBe(302);
      expect(calls[0]?.url).toBe(`https://cid.contact/cid/${PIECE_CID}`);
    });
  }
});

describe("cache failures", () => {
  it("treats a rejecting cache.match as a miss and swallows a rejecting cache.put", async () => {
    const cache = {
      match: async () => {
        throw new Error("cache down");
      },
      put: async () => {
        throw new Error("cache write down");
      }
    } as unknown as Pick<Cache, "match" | "put">;
    const { fetch: fetchImpl, calls } = stubFetch({ body: pieceHitFixture });
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      deps
    );
    await flush(deps);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect(calls).toHaveLength(1);
  });
});

describe("indexer request details and env overrides", () => {
  it("builds the fetch URL without a double slash for a trailing-slash INDEXER_URL", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ body: pieceHitFixture });
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      { INDEXER_URL: "https://indexer.example.com/" },
      makeDeps(fetchImpl)
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`https://sp.example.com/piece/${PIECE_CID}`);
    expect(calls[0]?.url).toBe(`https://indexer.example.com/cid/${PIECE_CID}`);
    expect(calls[0]?.url).not.toContain("//cid/");
  });

  it("honours a valid custom CACHE_TTL_SECONDS", async () => {
    const { fetch: fetchImpl } = stubFetch({ body: pieceHitFixture });
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      { CACHE_TTL_SECONDS: "60" },
      makeDeps(fetchImpl)
    );
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("502s without caching when the indexer body is not valid JSON", async () => {
    const cache = new FakeCache();
    const { fetch: fetchImpl } = stubFetch({
      response: new Response("this is not json {", { status: 200 })
    });
    const deps = makeDeps(fetchImpl, cache);
    const resp = await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      deps
    );
    await flush(deps);
    expect(resp.status).toBe(502);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(cache.putCount).toBe(0);
  });

  it("sends Accept: application/json and an abort signal to the indexer", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ body: pieceHitFixture });
    await handle(
      get("https://redirect.example.com/retrieve/" + PIECE_CID),
      PIECE_CID,
      {},
      makeDeps(fetchImpl)
    );
    const init = calls[0]?.init;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Accept).toBe("application/json");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
