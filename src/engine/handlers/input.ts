// Each operation's input is described once, as the JSON Schema the tool server publishes,
// and checked here against that same schema, so the published shape and the enforced one
// cannot drift apart.
import { HandlerError } from "./errors.ts";

/** Schema pattern: text with a non-space character. */
export const NOT_BLANK = "\\S";
/** Schema pattern: a record id. Ids are Crockford base32, which reads lower case as upper case. */
export const RECORD_ID = "^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$";

export type FieldSchema =
  | { type: "string"; description: string; enum?: readonly string[]; pattern?: string }
  | { type: "integer"; description: string; minimum: number; maximum: number };

export type InputSchema = {
  type: "object";
  properties: Record<string, FieldSchema>;
  required: readonly string[];
  additionalProperties: false;
};

function describeField(name: string, field: FieldSchema): string {
  if (field.type === "integer") return `${name} must be an integer from ${field.minimum} to ${field.maximum}`;
  if (field.enum) return `${name} must be one of ${field.enum.join(", ")}`;
  if (field.pattern === RECORD_ID) return `${name} must be a 26-character record id, such as 01KA0000000000000000000000`;
  if (field.pattern === NOT_BLANK) return `${name} must be text that is not blank`;
  if (field.pattern !== undefined) return `${name} must be text matching /${field.pattern}/`;
  return `${name} must be text`;
}

function fieldValue(name: string, field: FieldSchema, value: unknown): unknown {
  const refuse = () => new HandlerError("invalid_input", `${describeField(name, field)}, got ${JSON.stringify(value)}`);
  if (field.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value) || value < field.minimum || value > field.maximum) throw refuse();
    return value;
  }
  if (typeof value !== "string") throw refuse();
  if (field.enum !== undefined && !field.enum.includes(value)) throw refuse();
  if (field.pattern !== undefined && !new RegExp(field.pattern, "u").test(value)) throw refuse();
  return field.pattern === RECORD_ID ? value.toUpperCase() : value;
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
