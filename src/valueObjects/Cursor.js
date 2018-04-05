import isArray from "lodash/isArray";
import isEqual from "lodash/isEqual";

/*
  Cursors are POJOs with a few requirements:

  - They _must_ have an `actions` list. (It may be empty, but it must
    be present).

  - They _may_ include a `meta` key, which _is_ usable by the core
    code. This may contain `index` and `pageSize`, which should both
    be numbers.

  - They _may_ include a value at the `data` key, which _must_ be
    serializable using JSON.stringify and JSON.parse (we may want to
    allow other types that we know how to serialize, such as
    Immutable.js `Map`s, in the future)

  - They _must not_ include any further keys.
*/

const isSerializable = v => isEqual(v, JSON.parse(JSON.stringify(v)))
const validKeys = ({ required=[], optional=[] }, obj) =>
  obj &&
  required.every(key => !!obj[key]) &&
  Object.keys(obj).every(key => required.includes(key) || optional.includes(key));

export const validateCursor = cursor =>
  validKeys({ required: ["actions"], optional: ["data", "meta"] }, cursor) &&
  isArray(cursor.actions) &&
  isSerializable(cursor.data) &&
  (!cursor.meta || validKeys({ optional: ["index", "count", "pageSize", "pageCount"] }, cursor.meta));

export const invalidCursorError = cursor => new Error("Invalid cursor returned!");
