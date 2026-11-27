// Reads a tar archive (POSIX.1-2008, "pax"; the ustar format and its pax extended headers): the
// files it holds, as a package registry packs a package. Enough for a tool's release: it reads
// regular files and folders, takes a long name from a pax or GNU long-name header, and refuses any
// other kind of entry, such as a link, saying so.

/** The size of a block, a header's and the unit a file's data is padded to. */
const BLOCK = 512;
/** The fields of a header that the reader reads: where each starts and how long it is. */
const NAME = { at: 0, length: 100 };
const SIZE = { at: 124, length: 12 };
const TYPE = 156;
const PREFIX = { at: 345, length: 155 };
const MAGIC = { at: 257, length: 5 };
/** The magic of a ustar header, which a GNU header shares. */
const USTAR = "ustar";
/** The kinds of entry, by their type flag. */
const FILE_TYPES = new Set(["0", "\0", "7"]);
const FOLDER_TYPE = "5";
const PAX_ENTRY = "x";
const PAX_GLOBAL = "g";
const GNU_LONG_NAME = "L";
/** The pax record that gives an entry's path. */
const PAX_PATH = "path";

/** One file of the archive: its path as written, and its bytes. */
export type TarEntry = { name: string; directory: boolean; data: Uint8Array };

const text = (bytes: Uint8Array, at: number, length: number): string => {
  const field = bytes.subarray(at, at + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
};

/** A number field, in octal digits; a field that starts with the high bit holds it in base 256 (GNU). */
function numberField(bytes: Uint8Array, at: number, length: number): number {
  if ((bytes[at]! & 0x80) !== 0) {
    let n = bytes[at]! & 0x7f;
    for (let i = at + 1; i < at + length; i++) n = n * 256 + bytes[i]!;
    return n;
  }
  const digits = text(bytes, at, length).trim();
  return digits === "" ? 0 : Number.parseInt(digits, 8);
}

/** The records of a pax extended header: `<length> <key>=<value>\n`, each. */
function paxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const body = new TextDecoder().decode(data);
  for (const line of body.split("\n")) {
    const space = line.indexOf(" ");
    const equals = line.indexOf("=", space);
    if (space < 0 || equals < 0) continue;
    records.set(line.slice(space + 1, equals), line.slice(equals + 1));
  }
  return records;
}

/** The entries of an (unpacked) tar archive, in order. Throws when it is not one it reads. */
export function tarEntries(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | null = null;
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const header = archive.subarray(at, at + BLOCK);
    // Two blocks of zeros end the archive; one is enough to stop at.
    if (header.every((byte) => byte === 0)) break;
    if (text(header, MAGIC.at, MAGIC.length) !== USTAR) throw new Error("the archive is not a ustar or pax tar archive");
    const size = numberField(header, SIZE.at, SIZE.length);
    const type = String.fromCharCode(header[TYPE]!);
    const start = at + BLOCK;
    if (start + size > archive.length) throw new Error("the archive ends inside an entry");
    const data = archive.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === PAX_ENTRY) {
      longName = paxRecords(data).get(PAX_PATH) ?? longName;
      continue;
    }
    if (type === GNU_LONG_NAME) {
      longName = text(data, 0, data.length);
      continue;
    }
    if (type === PAX_GLOBAL) continue;
    const prefix = text(header, PREFIX.at, PREFIX.length);
    const short = text(header, NAME.at, NAME.length);
    const name = longName ?? (prefix === "" ? short : `${prefix}/${short}`);
    longName = null;
    if (type === FOLDER_TYPE) entries.push({ name, directory: true, data: new Uint8Array() });
    else if (FILE_TYPES.has(type)) entries.push({ name, directory: false, data });
    else throw new Error(`the archive holds ${name}, an entry of type ${JSON.stringify(type)}, which is not a file or a folder`);
  }
  return entries;
}
