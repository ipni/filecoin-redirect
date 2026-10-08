import { CID } from "multiformats/cid";

export const PIECE_HTTP = 0x0930;

export interface ProviderResult {
  ContextID?: string;
  Metadata?: string;
  Provider?: {
    ID?: string;
    Addrs?: string[] | null;
  };
}

export interface MultihashResult {
  Multihash?: string;
  ProviderResults?: ProviderResult[] | null;
}

export interface FindResponse {
  MultihashResults?: MultihashResult[] | null;
}

const BITSWAP = 0x0900;
const GRAPHSYNC = 0x0910;

const MAX_UVARINT_BYTES = 9;
const MAX_UVARINT_VALUE = Number.MAX_SAFE_INTEGER;

const HOST_RE = /^[a-z0-9.-]+$/i;
const PORT_RE = /^[0-9]+$/;
const PATH_RE = /^[A-Za-z0-9._~/-]*$/;

export function parseCid(s: string): CID | null {
  try {
    return CID.parse(s);
  } catch {
    return null;
  }
}

export function isPieceCid(cid: CID): boolean {
  return cid.version === 1 && cid.code === 0x55 && cid.multihash.code === 0x1011;
}

function decodeBase64(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function readUvarint(
  bytes: Uint8Array,
  offset: number
): { value: number; offset: number } | null {
  let result = 0;
  let shift = 0;
  let consumed = 0;
  for (;;) {
    if (offset >= bytes.length) {
      return null;
    }
    const byte = bytes[offset];
    consumed++;
    if (consumed > MAX_UVARINT_BYTES) {
      return null;
    }
    const added = (byte & 0x7f) * 2 ** shift;
    if (result + added > MAX_UVARINT_VALUE) {
      return null;
    }
    result += added;
    offset++;
    if ((byte & 0x80) === 0) {
      return { value: result, offset };
    }
    shift += 7;
  }
}

function fitsInBuffer(bytes: Uint8Array, value: number, end: number): boolean {
  return Number.isSafeInteger(value) && value <= bytes.length - end;
}

export function hasPieceHttp(b64: string): boolean {
  const bytes = decodeBase64(b64);
  if (bytes === null) {
    return false;
  }
  let offset = 0;
  while (offset < bytes.length) {
    const code = readUvarint(bytes, offset);
    if (code === null) {
      return false;
    }
    offset = code.offset;
    if (code.value === GRAPHSYNC) {
      return false;
    }
    if (code.value === BITSWAP) {
      continue;
    }
    const length = readUvarint(bytes, offset);
    if (length === null || !fitsInBuffer(bytes, length.value, length.offset)) {
      return false;
    }
    if (code.value === PIECE_HTTP) {
      return true;
    }
    offset = length.offset + length.value;
  }
  return false;
}

interface MultiaddrTail {
  port: number | null;
  sniHost: string | null;
  path: string;
  end: number;
}

function parseMultiaddrTail(segments: string[]): MultiaddrTail | null {
  let index = 0;
  let port: number | null = null;
  if (segments[index] === "tcp") {
    index++;
    const raw = segments[index];
    if (raw === undefined || !PORT_RE.test(raw)) {
      return null;
    }
    const parsed = Number(raw);
    if (parsed < 1 || parsed > 65535) {
      return null;
    }
    port = parsed;
    index++;
  }

  let sniHost: string | null = null;
  const security = segments[index];
  if (security === "https") {
    index++;
  } else if (security === "tls") {
    index++;
    const next = segments[index];
    if (next === "http") {
      index++;
    } else if (next === "sni") {
      index++;
      const sni = segments[index];
      if (sni === undefined || !HOST_RE.test(sni)) {
        return null;
      }
      sniHost = sni;
      index++;
      if (segments[index] !== "http") {
        return null;
      }
      index++;
    } else {
      return null;
    }
  } else {
    return null;
  }

  let path = "";
  if (segments[index] === "http-path") {
    index++;
    const encoded = segments[index];
    if (encoded === undefined) {
      return null;
    }
    index++;
    let decoded: string;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (!decoded.startsWith("/")) {
      decoded = `/${decoded}`;
    }
    if (decoded.endsWith("/")) {
      decoded = decoded.slice(0, -1);
    }
    if (!PATH_RE.test(decoded)) {
      return null;
    }
    for (const segment of decoded.split("/").slice(1)) {
      if (segment === "" || segment === "." || segment === "..") {
        return null;
      }
    }
    path = decoded;
  }

  if (segments[index] === "p2p") {
    index++;
    if (segments[index] === undefined) {
      return null;
    }
    index++;
  }

  return { port, sniHost, path, end: index };
}

export function multiaddrToBase(ma: string): string | null {
  if (!ma.startsWith("/")) {
    return null;
  }
  const segments = ma.split("/").slice(1);
  if (segments.length === 0 || segments.some((s) => s === "")) {
    return null;
  }

  let host: string | null = null;
  let index = 0;
  const protocol = segments[0];
  if (protocol === "dns" || protocol === "dns4" || protocol === "dns6" || protocol === "ip4") {
    const value = segments[1];
    if (value === undefined || !HOST_RE.test(value)) {
      return null;
    }
    host = value;
    index = 2;
  }

  if (host === null) {
    return null;
  }

  const rest = segments.slice(index);
  const tail = parseMultiaddrTail(rest);
  if (tail === null) {
    return null;
  }
  if (rest.length !== tail.end) {
    return null;
  }

  const authority = tail.sniHost ?? host;
  const portSuffix = tail.port === null || tail.port === 443 ? "" : `:${tail.port}`;
  return `https://${authority}${portSuffix}${tail.path}`;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function pickProviderBase(find: FindResponse): string | null {
  for (const multihashValue of toArray(find.MultihashResults)) {
    const multihashResult = toRecord(multihashValue);
    if (multihashResult === null) {
      continue;
    }
    for (const providerValue of toArray(multihashResult.ProviderResults)) {
      const providerResult = toRecord(providerValue);
      if (providerResult === null) {
        continue;
      }
      const metadata =
        typeof providerResult.Metadata === "string" ? providerResult.Metadata : "";
      if (!hasPieceHttp(metadata)) {
        continue;
      }
      const provider = toRecord(providerResult.Provider);
      for (const addr of toArray(provider?.Addrs)) {
        if (typeof addr !== "string") {
          continue;
        }
        const base = multiaddrToBase(addr);
        if (base !== null) {
          return base;
        }
      }
    }
  }
  return null;
}

export function pieceLocation(base: string, cid: CID): string {
  return `${base}/piece/${cid.toString()}`;
}

export function gatewayLocation(gatewayBase: string, cid: CID): string {
  return `${gatewayBase.replace(/\/+$/, "")}/ipfs/${cid.toString()}`;
}
