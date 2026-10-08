import { CID } from "multiformats/cid";

export const PIECE_HTTP = 0x0930;
export const GATEWAY_HTTP = 0x0920;

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

const LABEL_RE = /^[a-z0-9-]{1,63}$/;
const NUMERIC_LABEL_RE = /^([0-9]+|0x[0-9a-f]*)$/i;
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".lan",
  ".home",
  ".arpa"
];
const MAX_HOST_LENGTH = 253;

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

export function hasTransport(b64: string, code: number): boolean {
  const bytes = decodeBase64(b64);
  if (bytes === null) {
    return false;
  }
  let offset = 0;
  while (offset < bytes.length) {
    const entry = readUvarint(bytes, offset);
    if (entry === null) {
      return false;
    }
    offset = entry.offset;
    if (entry.value === GRAPHSYNC) {
      return false;
    }
    if (entry.value === BITSWAP) {
      continue;
    }
    const length = readUvarint(bytes, offset);
    if (length === null || !fitsInBuffer(bytes, length.value, length.offset)) {
      return false;
    }
    if (entry.value === code) {
      return true;
    }
    offset = length.offset + length.value;
  }
  return false;
}

export function hasPieceHttp(b64: string): boolean {
  return hasTransport(b64, PIECE_HTTP);
}

export function hasGatewayHttp(b64: string): boolean {
  return hasTransport(b64, GATEWAY_HTTP);
}

function isPublicHost(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.length === 0 || lower.length > MAX_HOST_LENGTH) {
    return false;
  }
  if (lower === "localhost") {
    return false;
  }
  for (const suffix of LOCAL_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return false;
    }
  }
  const labels = lower.split(".");
  if (labels.length < 2) {
    return false;
  }
  for (const label of labels) {
    if (!LABEL_RE.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return false;
    }
  }
  return !NUMERIC_LABEL_RE.test(labels[labels.length - 1]);
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
      if (sni === undefined || !isPublicHost(sni)) {
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
    if (value === undefined || (protocol !== "ip4" && !isPublicHost(value))) {
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
  if (protocol === "ip4" && tail.sniHost === null) {
    return null;
  }

  const authority = tail.sniHost ?? host;
  const portSuffix = tail.port === null || tail.port === 443 ? "" : `:${tail.port}`;
  return `https://${authority}${portSuffix}${tail.path}`;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickBase(find: FindResponse, code: number): string | null {
  for (const multihashValue of toArray(find.MultihashResults)) {
    const multihashResult = asRecord(multihashValue);
    if (multihashResult === null) {
      continue;
    }
    for (const providerValue of toArray(multihashResult.ProviderResults)) {
      const providerResult = asRecord(providerValue);
      if (providerResult === null) {
        continue;
      }
      const metadata =
        typeof providerResult.Metadata === "string" ? providerResult.Metadata : "";
      if (!hasTransport(metadata, code)) {
        continue;
      }
      const provider = asRecord(providerResult.Provider);
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

export function pickProviderBase(find: FindResponse): string | null {
  return pickBase(find, PIECE_HTTP);
}

export function pickGatewayBase(find: FindResponse): string | null {
  return pickBase(find, GATEWAY_HTTP);
}

export function pieceLocation(base: string, cid: CID): string {
  return `${base}/piece/${cid.toString()}`;
}

export function ipfsLocation(base: string, cid: CID): string {
  return `${base}/ipfs/${cid.toString()}?format=car`;
}
