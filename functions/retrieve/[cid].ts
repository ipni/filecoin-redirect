import type { Deps, Env } from "../../src/handler";
import { handle } from "../../src/handler";

function depsFor(
  ctx: EventContext<Env, "cid", Record<string, unknown>>
): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    cache: caches.default,
    waitUntil: (p) => ctx.waitUntil(p)
  };
}

export const onRequestGet: PagesFunction<Env> = (ctx) =>
  handle(ctx.request, String(ctx.params.cid), ctx.env, depsFor(ctx));

export const onRequestHead = onRequestGet;
