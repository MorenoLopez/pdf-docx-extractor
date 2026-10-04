/**
 * ECMA-376 Agile Encryption (MS-OFFCRYPTO) for password-protected OOXML
 * packages. An encrypted `.docx` is an OLE compound file, not a zip, so mammoth
 * cannot open it until the `EncryptedPackage` stream has been decrypted.
 *
 * agile scheme only (Office 2010 SP1 and later, which is also what
 * LibreOffice writes). Standard Encryption (Office 2007 and older) would need
 * MD5 plus an AES-ECB cipher, neither of which WebCrypto provides; add them only
 * if such a file ever shows up.
 */

import { cbc } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import type { CHash } from '@noble/hashes/utils.js';
import { buildError } from '../utils/errors';

/** AES block size. Office always writes 16 here. */
const BLOCK_SIZE = 16;
/** The payload is encrypted in independent segments, one IV each. */
const SEGMENT_SIZE = 4096;

/** `CHash` rather than a bare signature: `hmac` needs the hash object, not a callback. */
type HashFn = CHash;

const HASHES: Record<string, HashFn> = {
  SHA1: sha1,
  SHA256: sha256,
  SHA384: sha384,
  SHA512: sha512,
};

/** Block keys splitting the password hash into independent keys (MS-OFFCRYPTO 2.3.4.11). */
const BLK_VERIFIER_INPUT = hex('fea7d2763b4b9e79');
const BLK_VERIFIER_VALUE = hex('d7aa0f6d3061344e');
const BLK_KEY_VALUE = hex('146e0be7abacd0d6');
const BLK_HMAC_KEY = hex('5fb2ad010cb9e1f6');
const BLK_HMAC_VALUE = hex('a0677f02b22c8433');

/** OLE compound file magic, unlike the `PK` of a plain OOXML zip. */
const OLE_MAGIC = hex('d0cf11e0a1b11ae1');

/**
 * Passes an OOXML package through untouched, or decrypted when it is
 * password-protected. Throws `PASSWORD_REQUIRED`, `PASSWORD_INCORRECT` or
 * `ENCRYPTION_UNSUPPORTED`.
 */
export function unencryptOoxml(data: ArrayBuffer, password: string): ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (!matches(bytes, OLE_MAGIC)) return data;

  let payload: Uint8Array | undefined;
  let descriptor: Uint8Array | undefined;
  try {
    const stream = openCompoundFile(bytes);
    payload = stream('EncryptedPackage');
    descriptor = stream('EncryptionInfo');
  } catch (err) {
    // Not a readable compound file: let mammoth report DOCX_INVALID.
    console.error('[ooxml] conteneur OLE illisible', err);
    return data;
  }

  // A legacy binary `.doc` also uses the OLE container but has no such stream.
  if (!payload || !descriptor) return data;
  if (password === '') throw buildError('PASSWORD_REQUIRED');

  const isAgile =
    descriptor.byteLength >= 8 && descriptor[0] === 4 && descriptor[2] === 4;
  if (!isAgile) throw buildError('ENCRYPTION_UNSUPPORTED');

  const xml = new TextDecoder().decode(descriptor.subarray(8));
  return decryptAgile(xml, payload, password);
}

function decryptAgile(descriptor: string, payload: Uint8Array, password: string): ArrayBuffer {
  // Every parameter of the password scheme sits on the `<p:encryptedKey>` nested
  // inside `<keyEncryptor uri=".../password">`, not on the `<keyEncryptor>` itself.
  const passwordBlock = match(descriptor, /<keyEncryptor\b[^>]*password[^>]*>[\s\S]*?<\/keyEncryptor>/);
  const keyTag = match(passwordBlock, /<(?:\w+:)?encryptedKey\b[^>]*>/);
  const dataTag = match(descriptor, /<keyData\b[^>]*>/);
  const integrity = match(descriptor, /<dataIntegrity\b[^>]*>/);

  const passwordHash = pickHash(attribute(keyTag, 'hashAlgorithm'));
  const dataHash = pickHash(attribute(dataTag, 'hashAlgorithm'));
  const salt = base64(attribute(keyTag, 'saltValue'));
  const spinCount = Number(attribute(keyTag, 'spinCount'));
  const keyLength = Number(attribute(keyTag, 'keyBits')) / 8;

  // Certificate-only packages carry no password block: nothing to derive from.
  if (keyTag === '' || dataTag === '' || !(keyLength >= 16)) {
    throw buildError('ENCRYPTION_UNSUPPORTED');
  }

  // Iterated hash: H(salt + password), then H(iterator + H) spinCount times.
  let iterated = passwordHash(cat(salt, utf16le(password)));
  for (let i = 0; i < spinCount; i += 1) iterated = passwordHash(cat(le32(i), iterated));

  // One more round per purpose, so a single password derives several keys.
  const deriveKey = (blockKey: Uint8Array): Uint8Array =>
    passwordHash(cat(iterated, blockKey)).subarray(0, keyLength);
  const keyIv = asIv(salt);

  const expectedHash = decryptAes(
    deriveKey(BLK_VERIFIER_VALUE),
    keyIv,
    base64(attribute(keyTag, 'encryptedVerifierHashValue')),
  );
  const actualHash = passwordHash(
    decryptAes(
      deriveKey(BLK_VERIFIER_INPUT),
      keyIv,
      base64(attribute(keyTag, 'encryptedVerifierHashInput')),
    ),
  );
  if (!sameBytes(expectedHash, actualHash)) throw buildError('PASSWORD_INCORRECT');

  const secretKey = decryptAes(
    deriveKey(BLK_KEY_VALUE),
    keyIv,
    base64(attribute(keyTag, 'encryptedKeyValue')),
  );

  const dataSalt = base64(attribute(dataTag, 'saltValue'));
  const hmacKey = decryptAes(
    secretKey,
    asIv(dataHash(cat(dataSalt, BLK_HMAC_KEY))),
    base64(attribute(integrity, 'encryptedHmacKey')),
  );
  const hmacValue = decryptAes(
    secretKey,
    asIv(dataHash(cat(dataSalt, BLK_HMAC_VALUE))),
    base64(attribute(integrity, 'encryptedHmacValue')),
  );
  // The password is already proven right, so a mismatch means a damaged file.
  if (!sameBytes(hmacValue, hmac(dataHash, hmacKey, payload))) throw damaged();

  // The stream starts with the plaintext size, then the encrypted segments.
  if (payload.byteLength < BLOCK_SIZE) throw damaged();
  const totalSize = Number(
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0, true),
  );
  const body = payload.subarray(8);
  const out = new ArrayBuffer(totalSize);
  const view = new Uint8Array(out);

  let written = 0;
  for (let segment = 0; written < totalSize; segment += 1) {
    const chunk = body.subarray(segment * SEGMENT_SIZE, (segment + 1) * SEGMENT_SIZE);
    if (chunk.length === 0 || chunk.length % BLOCK_SIZE !== 0) throw damaged();
    const plain = decryptAes(secretKey, asIv(dataHash(cat(dataSalt, le32(segment)))), chunk);
    const take = Math.min(plain.length, totalSize - written);
    view.set(plain.subarray(0, take), written);
    written += take;
  }

  return out;
}

/** Raw CBC: the metadata fields carry no PKCS#7 padding, only the last segment does. */
function decryptAes(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, iv, { disablePadding: true }).decrypt(data);
}

function damaged(): never {
  throw buildError('DOCX_INVALID', 'Ce document chiffré semble corrompu, decryption impossible.');
}

function pickHash(name: string): HashFn {
  const hash = HASHES[name];
  if (!hash) throw buildError('ENCRYPTION_UNSUPPORTED', undefined, new Error(`hash ${name}`));
  return hash;
}

/** Short salts are padded with 0x36, the CryptoAPI convention. */
function asIv(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= BLOCK_SIZE) return bytes.subarray(0, BLOCK_SIZE);
  const padded = new Uint8Array(BLOCK_SIZE).fill(0x36);
  padded.set(bytes);
  return padded;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function matches(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function base64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

function utf16le(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i += 1) {
    out[i * 2] = text.charCodeAt(i) & 0xff;
    out[i * 2 + 1] = text.charCodeAt(i) >> 8;
  }
  return out;
}

function le32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function match(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[0] ?? '';
}

function attribute(tag: string, name: string): string {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
}

/* -------------------------------------------------------------------------- */
/* OLE compound file reader (MS-CFB), limited to the two streams we need.      */
/* -------------------------------------------------------------------------- */

interface DirectoryEntry {
  type: number;
  start: number;
  size: number;
}

/**
 * Opens a compound file and returns a stream lookup by name.
 *
 * The OLE container is parsed here rather than through a library because
 * `cfb` materialises every stream as a plain `Array` of numbers outside Node,
 * which cannot hold the tens of megabytes of an encrypted package.
 */
function openCompoundFile(bytes: Uint8Array): (name: string) => Uint8Array | undefined {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << header.getUint16(0x1e, true);
  const miniSectorSize = 1 << header.getUint16(0x20, true);
  const miniCutoff = header.getUint32(0x38, true);
  const fatSectorCount = header.getUint32(0x2c, true);

  const sector = (index: number): Uint8Array => {
    const offset = (index + 1) * sectorSize;
    if (index < 0 || offset + sectorSize > bytes.length) throw new Error('secteur hors limites');
    return bytes.subarray(offset, offset + sectorSize);
  };

  // The FAT sector list lives in the header (109 entries) then in a DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i += 1) {
    const entry = header.getInt32(0x4c + i * 4, true);
    if (entry >= 0) fatSectors.push(entry);
  }
  const perSector = sectorSize / 4 - 1;
  for (
    let next = header.getInt32(0x44, true), guard = header.getUint32(0x48, true);
    next >= 0 && guard > 0;
    guard -= 1
  ) {
    const block = sector(next);
    for (let i = 0; i < perSector && fatSectors.length < fatSectorCount; i += 1) {
      const entry = new DataView(block.buffer, block.byteOffset, block.byteLength).getInt32(i * 4, true);
      if (entry >= 0) fatSectors.push(entry);
    }
    next = new DataView(block.buffer, block.byteOffset, block.byteLength).getInt32(
      perSector * 4,
      true,
    );
  }

  const fat = new Int32Array(fatSectorCount * (sectorSize / 4));
  for (const index of fatSectors) {
    const block = sector(index);
    const table = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let i = 0; i < sectorSize / 4; i += 1) {
      fat[index * (sectorSize / 4) + i] = table.getInt32(i * 4, true);
    }
  }

  /** Follows a sector chain, concatenating whole sectors. */
  const readChain = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let written = 0;
    for (let i = start; i >= 0 && i < fat.length; i = fat[i]) {
      out.set(sector(i).subarray(0, Math.min(sectorSize, size - written)), written);
      written += sectorSize;
      if (written >= size) break;
    }
    return written < size ? out.subarray(0, written) : out;
  };

  /** Follows a mini sector chain inside the root stream, as [MS-CFB] 2.6.1 requires. */
  const readMiniChain = (miniFat: Uint8Array, root: Uint8Array, start: number, size: number) => {
    const out = new Uint8Array(size);
    let written = 0;
    for (let i = start; i >= 0 && i * 4 + 4 <= miniFat.length; i = readInt32(miniFat, i * 4)) {
      const at = i * miniSectorSize;
      out.set(root.subarray(at, at + Math.min(miniSectorSize, size - written)), written);
      written += miniSectorSize;
      if (written >= size) break;
    }
    return written < size ? out.subarray(0, written) : out;
  };

  const entries = new Map<string, DirectoryEntry>();
  // 0x28 holds the directory length; v3 containers leave it at 0, and readChain
  // stops on ENDOFCHAIN anyway, so the file size is a safe upper bound there.
  const dirSectors = header.getUint32(0x28, true);
  const directory = readChain(
    header.getInt32(0x30, true),
    dirSectors === 0 ? bytes.length : dirSectors * sectorSize,
  );
  for (let at = 0; at + 128 <= directory.length; at += 128) {
    const entry = directory.subarray(at, at + 128);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    // [MS-CFB] 2.6.1: 64 bytes of name, then its length in bytes, terminator included.
    const nameLength = view.getUint16(0x40, true);
    if (nameLength < 2 || nameLength > 64) continue;
    entries.set(new TextDecoder('utf-16le').decode(entry.subarray(0, nameLength - 2)), {
      type: entry[0x42],
      start: view.getInt32(0x74, true),
      size: Number(view.getBigUint64(0x78, true)),
    });
  }

  const root = entries.get('Root Entry');
  const miniFat =
    root === undefined
      ? new Uint8Array(0)
      : readChain(header.getInt32(0x3c, true), header.getUint32(0x40, true) * sectorSize);
  const miniRoot = root === undefined ? new Uint8Array(0) : readChain(root.start, root.size);

  return (name) => {
    const entry = entries.get(name);
    if (entry === undefined || entry.type !== 2) return undefined;
    return entry.size >= miniCutoff
      ? readChain(entry.start, entry.size)
      : readMiniChain(miniFat, miniRoot, entry.start, entry.size);
  };
}

function readInt32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
  );
}
