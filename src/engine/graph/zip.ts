// Reads a zip archive (PKWARE's APPNOTE.TXT, sections 4.3 and 4.4): the files its central
// directory lists, stored or deflated. Enough for a tool's release; it reads no Zip64 archive, no
// encrypted entry and no other compression, and says so.
import { inflateRawSync } from "node:zlib";

/** The signatures of the records the reader reads (APPNOTE.TXT 4.3.7, 4.3.12, 4.3.16). */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
/** The fixed sizes of those records, before their variable fields. */
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
/** The longest comment the end record may carry, which bounds the search for it. */
const MAX_COMMENT = 0xffff;
/** The compression methods read: stored and deflated (APPNOTE.TXT 4.4.5). */
const STORED = 0;
const DEFLATED = 8;
/** The flag bit of an encrypted entry (APPNOTE.TXT 4.4.4). */
const ENCRYPTED = 0x1;
/** The value a field takes when its Zip64 record holds the real one (APPNOTE.TXT 4.4.8). */
const ZIP64_MARK = 0xffffffff;

/** One file of the archive: its path as written, and a way to read its bytes. */
export type ZipEntry = { name: string; directory: boolean; read(): Uint8Array };

/** The entries of a zip archive, in the order its central directory lists them. Throws when the archive is not one it reads. */
export function zipEntries(archive: Uint8Array): ZipEntry[] {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let at = view.length - END_SIZE; at >= Math.max(0, view.length - END_SIZE - MAX_COMMENT); at--) {
    if (view.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip archive: no end of its central directory");
  const count = view.readUInt16LE(end + 10);
  let at = view.readUInt32LE(end + 16);
  if (at === ZIP64_MARK) throw new Error("a Zip64 archive, which tmb does not read");
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error("a damaged zip archive: its central directory is cut short");
    const flags = view.readUInt16LE(at + 8);
    const method = view.readUInt16LE(at + 10);
    const packed = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const local = view.readUInt32LE(at + 42);
    const name = view.toString("utf8", at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (packed === ZIP64_MARK || size === ZIP64_MARK || local === ZIP64_MARK) throw new Error(`${name}: a Zip64 entry, which tmb does not read`);
    if ((flags & ENCRYPTED) !== 0) throw new Error(`${name}: an encrypted entry`);
    if (method !== STORED && method !== DEFLATED) throw new Error(`${name}: compression method ${method}, which tmb does not read`);
    entries.push({
      name,
      directory: name.endsWith("/"),
      read() {
        if (view.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`${name}: a damaged zip archive`);
        const start = local + LOCAL_SIZE + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
        const data = view.subarray(start, start + packed);
        const out = method === STORED ? data : inflateRawSync(data);
        if (out.length !== size) throw new Error(`${name}: a damaged zip archive`);
        return new Uint8Array(out);
      },
    });
  }
  return entries;
}
