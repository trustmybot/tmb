// Record ids are ULIDs: 10 characters of millisecond time, then 16 random characters,
// all in Crockford base32. They sort as text in time order and never collide across
// machines, so a record can be copied to another database without renumbering.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;
const ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const ID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;

export type IdFactory = (floor?: string) => string;

export function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** The millisecond time an id was made at. */
export function idTime(id: string): number {
  if (!isId(id)) throw new Error(`not an id: ${JSON.stringify(id)}`);
  let time = 0;
  for (const char of id.slice(0, TIME_LENGTH)) time = time * 32 + ALPHABET.indexOf(char);
  return time;
}

function encodeTime(time: number): string {
  let text = "";
  for (let rest = time, i = 0; i < TIME_LENGTH; i++, rest = Math.floor(rest / 32)) text = ALPHABET[rest % 32] + text;
  return text;
}

function randomDigits(): number[] {
  // 256 is a multiple of 32, so masking each byte keeps the digits uniform.
  return Array.from(crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH)), (byte) => byte & 31);
}

/** Adds one to the random part in place; false when it was already all ones. */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i]! < 31) {
      digits[i]!++;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

/**
 * Makes an id generator that is monotonic: each id sorts after the one before, even
 * within one millisecond or when the clock steps back. A `floor` id, such as the newest
 * id already stored, makes the next id sort after it too.
 */
export function createIdFactory(clock: () => number = Date.now): IdFactory {
  let lastId = "";
  let lastTime = -1;
  let lastDigits: number[] = [];

  return (floor) => {
    if (floor !== undefined && floor > lastId) {
      lastTime = idTime(floor);
      lastDigits = Array.from(floor.slice(TIME_LENGTH), (char) => ALPHABET.indexOf(char));
    }
    const now = clock();
    if (now > lastTime) {
      lastTime = now;
      lastDigits = randomDigits();
    } else if (!increment(lastDigits)) {
      lastTime += 1;
      lastDigits = randomDigits();
    }
    if (lastTime > MAX_TIME) throw new Error("id time is past the year 10889");
    lastId = encodeTime(lastTime) + lastDigits.map((digit) => ALPHABET[digit]).join("");
    return lastId;
  };
}

/** The process-wide generator, shared so every store in one process stays monotonic. */
export const newId: IdFactory = createIdFactory();
