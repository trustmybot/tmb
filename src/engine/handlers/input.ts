// Each operation's input is described once, as the JSON Schema the tool server publishes,
// and checked here against that same schema, so the published shape and the enforced one
// cannot drift apart.
import { HandlerError } from "./errors.ts";

/** Schema pattern: text with a non-space character. */
export const NOT_BLANK = "\\S";
/** Schema pattern: a record id. Ids are Crockford base32, which reads lower case as upper case. */
export const RECORD_ID = "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$";

type TextSchema = { type: "string"; description: string; enum?: readonly string[]; pattern?: string };

export type FieldSchema =
  | TextSchema
  | { type: "integer"; description: string; minimum: number; maximum: number }
  | { type: "array"; description: string; items: Omit<TextSchema, "description">; minItems?: number };

export type InputSchema = {
  type: "object";
  properties: Record<string, FieldSchema>;
  required: readonly string[];
  additionalProperties: false;
};

function describeText(field: Omit<TextSchema, "description">): string {
  if (field.enum) return `one of ${field.enum.join(", ")}`;
  if (field.pattern === RECORD_ID) return "a 26-character record id, such as 01KA0000000000000000000000";
  if (field.pattern === NOT_BLANK) return "text that is not blank";
  if (field.pattern !== undefined) return `text matching /${field.pattern}/`;
  return "text";
}

function describeField(name: string, field: FieldSchema): string {
  if (field.type === "integer") return `${name} must be an integer from ${field.minimum} to ${field.maximum}`;
  if (field.type === "array") {
    const least = field.minItems === undefined || field.minItems === 0 ? "" : ` of at least ${field.minItems}`;
    return `${name} must be a list${least}, each item ${describeText(field.items)}`;
  }
  return `${name} must be ${describeText(field)}`;
}

function fieldValue(name: string, field: FieldSchema, value: unknown): unknown {
  const refuse = () => new HandlerError("invalid_input", `${describeField(name, field)}, got ${JSON.stringify(value)}`);
  if (field.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.minimum || value > field.maximum) throw refuse();
    return value;
  }
  if (field.type === "array") {
    if (!Array.isArray(value) || value.length < (field.minItems ?? 0)) throw refuse();
    return value.map((item) => {
      if (!textMatches(field.items, item)) throw refuse();
      return item;
    });
  }
  if (!textMatches(field, value)) throw refuse();
  return field.pattern === RECORD_ID ? (value as string).toUpperCase() : value;
}

function textMatches(field: Omit<TextSchema, "description">, value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (field.enum !== undefined && !field.enum.includes(value)) return false;
  return field.pattern === undefined || new RegExp(field.pattern, "u").test(value);
}

/** Checks `input` against `schema` and returns it with ids in upper case; throws a HandlerError naming what is allowed. */
export function validateInput<T>(operation: string, schema: InputSchema, input: unknown): T {
  const fields = Object.keys(schema.properties);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new HandlerError("invalid_input", `${operation} takes an object with ${fields.join(", ")}`);
  }
  const given = input as Record<string, unknown>;
  const unknownFields = Object.keys(given).filter((key) => !Object.hasOwn(schema.properties, key));
  if (unknownFields.length > 0) {
    throw new HandlerError("invalid_input", `${operation} does not take ${unknownFields.join(", ")}; allowed: ${fields.join(", ")}`);
  }
  const missing = schema.required.filter((key) => given[key] === undefined);
  if (missing.length > 0) throw new HandlerError("invalid_input", `${operation} needs ${missing.join(", ")}`);

  const checked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(given)) {
    if (value !== undefined) checked[name] = fieldValue(name, schema.properties[name]!, value);
  }
  return checked as T;
}
