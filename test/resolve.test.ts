import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { create as createDigest } from "multiformats/hashes/digest";
import {
  gatewayLocation,
  hasPieceHttp,
  isPieceCid,
  multiaddrToBase,
  parseCid,
  pieceLocation,
  pickProviderBase,
  type FindResponse
} from "../src/resolve";
import emptyFixture from "./fixtures/empty.json";
import gatewayOnlyFixture from "./fixtures/gateway-only.json";
import httpPathFixture from "./fixtures/http-path.json";
import mixedFixture from "./fixtures/mixed.json";
import nullProvidersFixture from "./fixtures/null-providers.json";
import pieceHitFixture from "./fixtures/piece-hit.json";

const PIECE_CID = "bafkzcibcfab4grpgq6e6rva4kfuxfcvibdzx3kn2jdw6q3zqgwt5cou7j6k4wfq";
const IPFS_CID = "bafybeihkoviema7g3gxyt6la7vd5ho32ictqbilu3wnlo3rs7ewhnp7lly";
const CIDV0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const PIECE_V1_CID = "baga6ea4seaqao7s73y24kcutaosvacpdjgfe5pw76ooefnyqw4ynr3d2y6x2mpq";

describe("parseCid", () => {
  it("parses a piece cid", () => {
    const cid = parseCid(PIECE_CID);
    expect(cid).not.toBeNull();
    expect(cid?.version).toBe(1);
    expect(cid?.code).toBe(0x55);
    expect(cid?.multihash.code).toBe(0x1011);
  });

  it("parses an ipfs cid", () => {
    expect(parseCid(IPFS_CID)?.multihash.code).toBe(0x12);
  });

  it("parses a v0 cid", () => {
    expect(parseCid(CIDV0)?.version).toBe(0);
  });

  it("parses a piece cid v1", () => {
    expect(parseCid(PIECE_V1_CID)?.multihash.code).toBe(0x1012);
  });

  it("returns null on garbage", () => {
    expect(parseCid("notacid")).toBeNull();
    expect(parseCid("")).toBeNull();
  });
});

describe("isPieceCid", () => {
  it("accepts piece cid v2", () => {
    expect(isPieceCid(parseCid(PIECE_CID) as never)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isPieceCid(parseCid(IPFS_CID) as never)).toBe(false);
    expect(isPieceCid(parseCid(CIDV0) as never)).toBe(false);
    expect(isPieceCid(parseCid(PIECE_V1_CID) as never)).toBe(false);
  });

  it("rejects a CIDv1 with dag-pb codec and the piece multihash", () => {
    const digest = createDigest(0x1011, new Uint8Array(32));
    const cid = CID.createV1(0x70, digest);
    expect(isPieceCid(cid)).toBe(false);
  });
});

describe("hasPieceHttp", () => {
  it("accepts a lone piece-http entry", () => {
    expect(hasPieceHttp("sBIA")).toBe(true);
  });

  it("accepts bitswap before piece-http", () => {
    expect(hasPieceHttp("gBKwEgA=")).toBe(true);
  });

  it("accepts gateway-http before piece-http", () => {
    expect(hasPieceHttp("oBIAsBIA")).toBe(true);
  });

  it("rejects gateway-http only", () => {
    expect(hasPieceHttp("oBIA")).toBe(false);
  });

  it("rejects empty metadata", () => {
    expect(hasPieceHttp("")).toBe(false);
  });

  it("rejects invalid base64", () => {
    expect(hasPieceHttp("!!!")).toBe(false);
  });

  it("rejects graphsync before piece-http", () => {
    expect(hasPieceHttp("kBIBILASAA==")).toBe(false);
  });

  it("accepts an unknown code with a payload before piece-http", () => {
    expect(hasPieceHttp("gEACqruwEgA=")).toBe(true);
  });

  it("rejects truncated metadata", () => {
    expect(hasPieceHttp("sBI=")).toBe(false);
    expect(hasPieceHttp("gEACqg==")).toBe(false);
  });

  it("rejects an overlong uvarint", () => {
    expect(hasPieceHttp("sBKAgICAgICAgIAB")).toBe(false);
    expect(hasPieceHttp("sBL///////////8B")).toBe(false);
  });

  it("rejects a length running past the end", () => {
    expect(hasPieceHttp("gEAFqg==")).toBe(false);
  });
});

describe("multiaddrToBase", () => {
  it("accepts /dns", () => {
    expect(multiaddrToBase("/dns/sp.example.com/https")).toBe("https://sp.example.com");
  });

  it("accepts /dns4", () => {
    expect(multiaddrToBase("/dns4/sp.example.com/https")).toBe("https://sp.example.com");
  });

  it("accepts /dns6", () => {
    expect(multiaddrToBase("/dns6/sp.example.com/https")).toBe("https://sp.example.com");
  });

  it("accepts /ip4", () => {
    expect(multiaddrToBase("/ip4/198.51.100.7/https")).toBe("https://198.51.100.7");
  });

  it("accepts /tls/http", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/443/tls/http")).toBe("https://sp.example.com");
  });

  it("keeps a non-443 port", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/8443/https")).toBe("https://sp.example.com:8443");
  });

  it("drops port 443", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/443/https")).toBe("https://sp.example.com");
  });

  it("decodes an http-path", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/443/https/http-path/%2Fsp1")).toBe(
      "https://sp.example.com/sp1"
    );
  });

  it("adds a leading slash and strips a trailing slash on http-path", () => {
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/sp1%2F")).toBe(
      "https://sp.example.com/sp1"
    );
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%2F")).toBe("https://sp.example.com");
  });

  it("ignores a trailing p2p suffix", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/443/https/p2p/12D3KooWSp")).toBe(
      "https://sp.example.com"
    );
  });

  it("uses the sni host", () => {
    expect(
      multiaddrToBase("/dns4/edge.example.com/tcp/443/tls/sni/sp.example.com/http")
    ).toBe("https://sp.example.com");
  });

  it("rejects plain http", () => {
    expect(multiaddrToBase("/dns/a.example.com/tcp/80/http")).toBeNull();
  });

  it("rejects /ip6", () => {
    expect(multiaddrToBase("/ip6/2001:db8::1/https")).toBeNull();
  });

  it("rejects garbage", () => {
    expect(multiaddrToBase("not-a-multiaddr")).toBeNull();
    expect(multiaddrToBase("/")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com")).toBeNull();
    expect(multiaddrToBase("/dns//https")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/tcp/443/https/quic")).toBeNull();
  });

  it("rejects a non-numeric port", () => {
    expect(multiaddrToBase("/dns/sp.example.com/tcp/abc/https")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/tcp/0/https")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/tcp/65536/https")).toBeNull();
  });

  it("rejects a malformed percent escape", () => {
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%zz")).toBeNull();
  });

  it("rejects a path containing ? or ..", () => {
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%2Fa%3Fb")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%2F..%2Fetc")).toBeNull();
  });

  it("rejects empty and dot http-path segments", () => {
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%2F%2F")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/a%2F%2Fb")).toBeNull();
    expect(multiaddrToBase("/dns/sp.example.com/https/http-path/%2Fa%2F.%2Fb")).toBeNull();
  });
});

describe("pickProviderBase", () => {
  it("picks the piece-http provider", () => {
    expect(pickProviderBase(pieceHitFixture as FindResponse)).toBe("https://sp.example.com");
  });

  it("returns null when only gateway-http metadata exists", () => {
    expect(pickProviderBase(gatewayOnlyFixture as FindResponse)).toBeNull();
  });

  it("skips a record whose addrs are not convertible", () => {
    expect(pickProviderBase(mixedFixture as FindResponse)).toBe("https://good.example.com");
  });

  it("honours an http-path addr", () => {
    expect(pickProviderBase(httpPathFixture as FindResponse)).toBe("https://sp.example.com/sp1");
  });

  it("returns null for an empty response", () => {
    expect(pickProviderBase(emptyFixture as FindResponse)).toBeNull();
  });

  it("tolerates a null ProviderResults", () => {
    expect(pickProviderBase(nullProvidersFixture as FindResponse)).toBe(
      "https://sp2.example.com:8443"
    );
  });
});

describe("pieceLocation", () => {
  it("builds the piece url", () => {
    const cid = parseCid(PIECE_CID) as never;
    expect(pieceLocation("https://sp.example.com", cid)).toBe(
      `https://sp.example.com/piece/${PIECE_CID}`
    );
  });
});

describe("gatewayLocation", () => {
  it("builds the gateway url", () => {
    const cid = parseCid(IPFS_CID) as never;
    expect(gatewayLocation("https://inbrowser.link", cid)).toBe(`https://inbrowser.link/ipfs/${IPFS_CID}`);
  });

  it("strips a trailing slash on the gateway base", () => {
    const cid = parseCid(IPFS_CID) as never;
    expect(gatewayLocation("https://inbrowser.link/", cid)).toBe(
      `https://inbrowser.link/ipfs/${IPFS_CID}`
    );
  });
});
