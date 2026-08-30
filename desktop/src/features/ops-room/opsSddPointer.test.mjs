import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Task 6a C3 - the cross-registry SDD pointer data file and its shape gate.
//
// The parser and validator below are deliberately test-local. Nothing in the
// desktop app reads the pointer yet, so shipping a runtime module would
// advertise a capability with no consumer. Keeping the rules here enforces the
// contract without adding a byte to the bundle or a name to any manifest.
//
// `docs/**` is outside biome's scope and outside the desktop CI path filter, so
// this test is the only gate that ever reads the real pointer bytes. It
// therefore pins the exact canonical values, not just the shape: any edit to the
// data file has to come back through here.
//
// The canonical-reserialization check is the load-bearing one. `JSON.parse`
// silently keeps the last of a duplicated key, so a key-set check alone cannot
// see duplicates. Comparing the reserialized canonical form against the original
// text catches key order, indentation, duplicates, line endings, and the final
// newline in a single comparison.

const POINTER_URL = new URL(
  "../../../../docs/superpowers/plans/2026-08-30-buzz-unified-connections-research-routing.pointer.json",
  import.meta.url,
);

/** Canonical key set and order. The serializer and the parser both read only this. */
const SDD_POINTER_KEYS = [
  "schema_version",
  "workspace_registry_id",
  "canonical_registry_id",
  "canonical_plan_relative_path",
  "canonical_plan_commit_sha",
  "canonical_plan_sha256",
  "review_receipt_sha256",
];

/** Every rejection this contract can produce. The set is the contract. */
const SDD_POINTER_CODES = [
  "sdd_pointer_too_large",
  "sdd_pointer_encoding",
  "sdd_pointer_malformed",
  "sdd_pointer_schema",
  "sdd_pointer_self",
];

const SDD_POINTER_MAX_BYTES = 8 * 1024;
const REGISTRY_ID_MIN = 3;
const REGISTRY_ID_MAX = 64;
const RELATIVE_PATH_MAX_BYTES = 200;
const RELATIVE_PATH_MAX_SEGMENTS = 8;
const RELATIVE_PATH_MAX_SEGMENT_BYTES = 128;
const COMMIT_SHA_LENGTHS = [40, 64];
const SHA256_LENGTHS = [64];

// Built at runtime so no literal control byte ever sits in this source file.
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const DEL = String.fromCharCode(127);

/** The expected canonical pointer. Values come from the approved Task 6a map. */
const EXPECTED_POINTER = {
  schema_version: 1,
  workspace_registry_id: "buzz-workspace",
  canonical_registry_id: "hub-unified-ops",
  canonical_plan_relative_path:
    "docs/superpowers/plans/2026-08-30-buzz-unified-connections-research-routing.md",
  canonical_plan_commit_sha: "032f6ff3e33ed1018a38dce27e79569ab4d3f994",
  canonical_plan_sha256:
    "ab98f32221e4beb4fa42b67c75cd831016dd425ca8e44c0fb907f2bef5235bb6",
  review_receipt_sha256:
    "3be860c514a308c7a210a5c10a82b5eaadd6718f7cffc97f0aa2a85f0f42aa55",
};

class SddPointerError extends Error {
  constructor(code) {
    super(code);
    this.name = "SddPointerError";
    this.code = code;
  }
}

const utf8Encoder = new TextEncoder();

function byteLength(value) {
  return utf8Encoder.encode(value).length;
}

/**
 * Canonical JSON uses LF only. Every other C0 control character and DEL is
 * rejected before parsing - CR and TAB are both inside that range, which is why
 * neither is measured separately. Checked by code point rather than by regex so
 * the forbidden range stays readable without suppressing a lint rule.
 */
function hasForbiddenControlCharacter(text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 10) continue;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

/** POSIX repository-relative path segments, or null when the syntax is refused. */
function pathSegments(value) {
  if (byteLength(value) > RELATIVE_PATH_MAX_BYTES) return null;
  // `split` always yields at least one segment; an empty one is caught below,
  // which is what rejects a leading "/".
  const parts = value.split("/");
  if (parts.length > RELATIVE_PATH_MAX_SEGMENTS) return null;
  for (const part of parts) {
    if (part.length < 1 || byteLength(part) > RELATIVE_PATH_MAX_SEGMENT_BYTES) {
      return null;
    }
    if (part === "." || part === ".." || /[^A-Za-z0-9._-]/.test(part)) {
      return null;
    }
  }
  return parts;
}

/** Repository-relative path pinned to its extension. The last segment may not be hidden. */
function isSddRelativePath(value, extension) {
  if (typeof value !== "string") return false;
  const parts = pathSegments(value);
  if (!parts) return false;
  const name = parts[parts.length - 1];
  return (
    /[A-Za-z0-9]/.test(name.charAt(0)) &&
    name.length > extension.length &&
    name.endsWith(extension)
  );
}

/** Stable workspace registry slug: lowercase, digits and hyphen only, first character a letter. */
function isSddWorkspaceRegistryId(value) {
  return (
    typeof value === "string" &&
    value.length >= REGISTRY_ID_MIN &&
    value.length <= REGISTRY_ID_MAX &&
    !/[^a-z0-9-]/.test(value) &&
    /[a-z]/.test(value.charAt(0))
  );
}

function isLowerHex(value, lengths) {
  return (
    typeof value === "string" &&
    lengths.includes(value.length) &&
    !/[^0-9a-f]/.test(value)
  );
}

function hasExactKeys(value, keys) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Canonical serialization: fixed key order, two-space indent, LF, one final newline. */
function serializeSddPointer(pointer) {
  const ordered = {};
  for (const key of SDD_POINTER_KEYS) ordered[key] = pointer[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function decodePointer(bytes) {
  if (bytes.byteLength > SDD_POINTER_MAX_BYTES) {
    throw new SddPointerError("sdd_pointer_too_large");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new SddPointerError("sdd_pointer_encoding");
  }
  if (text.includes(BOM) || hasForbiddenControlCharacter(text)) {
    throw new SddPointerError("sdd_pointer_encoding");
  }
  return text;
}

/**
 * Parse pointer bytes. Returning means those bytes are byte-for-byte identical
 * to the canonical serialization of the value returned.
 */
function parseSddPointer(bytes) {
  const text = decodePointer(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SddPointerError("sdd_pointer_malformed");
  }
  if (!hasExactKeys(parsed, SDD_POINTER_KEYS)) {
    throw new SddPointerError("sdd_pointer_schema");
  }
  if (
    parsed.schema_version !== 1 ||
    !isSddWorkspaceRegistryId(parsed.workspace_registry_id) ||
    !isSddWorkspaceRegistryId(parsed.canonical_registry_id) ||
    !isSddRelativePath(parsed.canonical_plan_relative_path, ".md") ||
    !isLowerHex(parsed.canonical_plan_commit_sha, COMMIT_SHA_LENGTHS) ||
    !isLowerHex(parsed.canonical_plan_sha256, SHA256_LENGTHS) ||
    !isLowerHex(parsed.review_receipt_sha256, SHA256_LENGTHS)
  ) {
    throw new SddPointerError("sdd_pointer_schema");
  }
  // A pointer naming its own registry as canonical would be a trust loop.
  if (parsed.workspace_registry_id === parsed.canonical_registry_id) {
    throw new SddPointerError("sdd_pointer_self");
  }
  if (serializeSddPointer(parsed) !== text) {
    throw new SddPointerError("sdd_pointer_schema");
  }
  return parsed;
}

function rejectionCode(bytes) {
  try {
    parseSddPointer(bytes);
  } catch (error) {
    assert.ok(error instanceof SddPointerError, `unexpected error: ${error}`);
    return error.code;
  }
  return null;
}

function bytesOf(text) {
  return utf8Encoder.encode(text);
}

function withValue(key, value) {
  return bytesOf(serializeSddPointer({ ...EXPECTED_POINTER, [key]: value }));
}

const canonicalText = serializeSddPointer(EXPECTED_POINTER);

test("the tracked pointer file is byte-for-byte canonical", () => {
  const bytes = readFileSync(POINTER_URL);

  assert.equal(new TextDecoder("utf-8").decode(bytes), canonicalText);
  assert.ok(bytes.byteLength <= SDD_POINTER_MAX_BYTES);
  assert.deepEqual(parseSddPointer(bytes), EXPECTED_POINTER);
});

test("the tracked pointer file carries the approved cross-registry values", () => {
  const pointer = parseSddPointer(readFileSync(POINTER_URL));

  assert.deepEqual(Object.keys(pointer), SDD_POINTER_KEYS);
  assert.equal(pointer.schema_version, 1);
  assert.equal(pointer.workspace_registry_id, "buzz-workspace");
  assert.equal(pointer.canonical_registry_id, "hub-unified-ops");
  assert.equal(
    pointer.canonical_plan_relative_path,
    "docs/superpowers/plans/2026-08-30-buzz-unified-connections-research-routing.md",
  );
  assert.equal(
    pointer.canonical_plan_commit_sha,
    "032f6ff3e33ed1018a38dce27e79569ab4d3f994",
  );
  assert.equal(
    pointer.canonical_plan_sha256,
    "ab98f32221e4beb4fa42b67c75cd831016dd425ca8e44c0fb907f2bef5235bb6",
  );
  assert.equal(
    pointer.review_receipt_sha256,
    "3be860c514a308c7a210a5c10a82b5eaadd6718f7cffc97f0aa2a85f0f42aa55",
  );
});

test("the tracked pointer file names no absolute path and no host bytes", () => {
  const text = readFileSync(POINTER_URL, "utf8");

  assert.ok(!text.includes("/Users"));
  assert.ok(!text.includes("\\"));
  assert.ok(!text.includes(BOM));
  assert.ok(!text.includes(CR));
  assert.ok(text.endsWith("}\n"));
  assert.ok(!text.endsWith("\n\n"));
});

test("the rejection vocabulary is exactly these five codes", () => {
  assert.deepEqual(SDD_POINTER_CODES, [
    "sdd_pointer_too_large",
    "sdd_pointer_encoding",
    "sdd_pointer_malformed",
    "sdd_pointer_schema",
    "sdd_pointer_self",
  ]);
  assert.equal(new Set(SDD_POINTER_CODES).size, SDD_POINTER_CODES.length);
});

test("a 64-hex canonical commit sha is accepted", () => {
  const bytes = withValue("canonical_plan_commit_sha", "b".repeat(64));

  assert.equal(
    parseSddPointer(bytes).canonical_plan_commit_sha,
    "b".repeat(64),
  );
});

const REJECTIONS = [
  // Key set and canonical form.
  [
    "unknown key",
    bytesOf(
      canonicalText.replace(
        '  "schema_version": 1,',
        '  "schema_version": 1,\n  "extra_key": 1,',
      ),
    ),
    "sdd_pointer_schema",
  ],
  [
    "missing key",
    bytesOf(
      canonicalText.replace(
        `,\n  "review_receipt_sha256": "${EXPECTED_POINTER.review_receipt_sha256}"`,
        "",
      ),
    ),
    "sdd_pointer_schema",
  ],
  [
    "duplicate key",
    bytesOf(
      canonicalText.replace(
        '  "schema_version": 1,',
        '  "schema_version": 1,\n  "schema_version": 1,',
      ),
    ),
    "sdd_pointer_schema",
  ],
  [
    "reordered keys",
    bytesOf(
      `${JSON.stringify(
        Object.fromEntries(
          [...SDD_POINTER_KEYS]
            .reverse()
            .map((key) => [key, EXPECTED_POINTER[key]]),
        ),
        null,
        2,
      )}\n`,
    ),
    "sdd_pointer_schema",
  ],
  [
    "four-space indent",
    bytesOf(`${JSON.stringify(EXPECTED_POINTER, null, 4)}\n`),
    "sdd_pointer_schema",
  ],
  [
    "no indent",
    bytesOf(`${JSON.stringify(EXPECTED_POINTER)}\n`),
    "sdd_pointer_schema",
  ],
  [
    "missing final newline",
    bytesOf(canonicalText.slice(0, -1)),
    "sdd_pointer_schema",
  ],
  [
    "doubled final newline",
    bytesOf(`${canonicalText}\n`),
    "sdd_pointer_schema",
  ],
  ["leading whitespace", bytesOf(` ${canonicalText}`), "sdd_pointer_schema"],
  ["json array", bytesOf("[]\n"), "sdd_pointer_schema"],
  ["json null", bytesOf("null\n"), "sdd_pointer_schema"],

  // Encoding faults.
  [
    "tab indent",
    bytesOf(`${JSON.stringify(EXPECTED_POINTER, null, TAB)}\n`),
    "sdd_pointer_encoding",
  ],
  [
    "crlf line endings",
    bytesOf(canonicalText.replaceAll("\n", `${CR}\n`)),
    "sdd_pointer_encoding",
  ],
  [
    "lone carriage return",
    bytesOf(canonicalText.replace("\n", CR)),
    "sdd_pointer_encoding",
  ],
  [
    "byte order mark",
    bytesOf(`${BOM}${canonicalText}`),
    "sdd_pointer_encoding",
  ],
  ["nul byte", bytesOf(`${canonicalText}${NUL}`), "sdd_pointer_encoding"],
  ["del byte", bytesOf(`${canonicalText}${DEL}`), "sdd_pointer_encoding"],
  [
    "invalid utf-8",
    Uint8Array.from([0x7b, 0xff, 0x7d, 0x0a]),
    "sdd_pointer_encoding",
  ],

  // Size.
  [
    "over 8 KiB",
    bytesOf(`${canonicalText}${" ".repeat(SDD_POINTER_MAX_BYTES)}`),
    "sdd_pointer_too_large",
  ],
  [
    "size is measured before encoding",
    Uint8Array.from({ length: SDD_POINTER_MAX_BYTES + 1 }, () => 0xff),
    "sdd_pointer_too_large",
  ],

  // Not JSON at all.
  ["not json", bytesOf("not json\n"), "sdd_pointer_malformed"],
  [
    "truncated json",
    bytesOf(canonicalText.slice(0, 40)),
    "sdd_pointer_malformed",
  ],
  ["empty file", bytesOf(""), "sdd_pointer_malformed"],

  // Values.
  ["schema_version 2", withValue("schema_version", 2), "sdd_pointer_schema"],
  [
    "schema_version as string",
    withValue("schema_version", "1"),
    "sdd_pointer_schema",
  ],
  [
    "null value",
    withValue("workspace_registry_id", null),
    "sdd_pointer_schema",
  ],
  [
    "registry id uppercase",
    withValue("workspace_registry_id", "Buzz-workspace"),
    "sdd_pointer_schema",
  ],
  [
    "registry id too short",
    withValue("workspace_registry_id", "bz"),
    "sdd_pointer_schema",
  ],
  [
    "registry id leading digit",
    withValue("workspace_registry_id", "1buzz"),
    "sdd_pointer_schema",
  ],
  [
    "registry id with dot",
    withValue("workspace_registry_id", "buzz.workspace"),
    "sdd_pointer_schema",
  ],
  [
    "registry id with slash",
    withValue("workspace_registry_id", "buzz/workspace"),
    "sdd_pointer_schema",
  ],
  [
    "registry id with underscore",
    withValue("workspace_registry_id", "buzz_workspace"),
    "sdd_pointer_schema",
  ],
  [
    "registry id too long",
    withValue("workspace_registry_id", `b${"z".repeat(REGISTRY_ID_MAX)}`),
    "sdd_pointer_schema",
  ],
  [
    "canonical registry id invalid",
    withValue("canonical_registry_id", "HUB"),
    "sdd_pointer_schema",
  ],
  [
    "self reference",
    withValue("workspace_registry_id", EXPECTED_POINTER.canonical_registry_id),
    "sdd_pointer_self",
  ],

  // Relative path syntax.
  [
    "absolute plan path",
    withValue(
      "canonical_plan_relative_path",
      `/${EXPECTED_POINTER.canonical_plan_relative_path}`,
    ),
    "sdd_pointer_schema",
  ],
  [
    "plan path escapes upward",
    withValue("canonical_plan_relative_path", "docs/../../etc/passwd.md"),
    "sdd_pointer_schema",
  ],
  [
    "plan path with dot segment",
    withValue("canonical_plan_relative_path", "docs/./plan.md"),
    "sdd_pointer_schema",
  ],
  [
    "plan path with backslash",
    withValue("canonical_plan_relative_path", "docs\\plan.md"),
    "sdd_pointer_schema",
  ],
  [
    "plan path with empty segment",
    withValue("canonical_plan_relative_path", "docs//plan.md"),
    "sdd_pointer_schema",
  ],
  // A nul inside a JSON string value is escaped by the serializer, so the file
  // holds no raw control byte and the decoder never sees it. The path grammar is
  // what refuses it. A raw nul byte in the file is the "nul byte" case above.
  [
    "plan path with an escaped nul",
    withValue("canonical_plan_relative_path", `docs/plan${NUL}.md`),
    "sdd_pointer_schema",
  ],
  [
    "plan path is not markdown",
    withValue("canonical_plan_relative_path", "docs/plan.json"),
    "sdd_pointer_schema",
  ],
  [
    "plan path last segment is hidden",
    withValue("canonical_plan_relative_path", "docs/.plan.md"),
    "sdd_pointer_schema",
  ],
  [
    "plan path is only an extension",
    withValue("canonical_plan_relative_path", "docs/.md"),
    "sdd_pointer_schema",
  ],
  [
    "plan path too deep",
    withValue(
      "canonical_plan_relative_path",
      `${"a/".repeat(RELATIVE_PATH_MAX_SEGMENTS)}plan.md`,
    ),
    "sdd_pointer_schema",
  ],
  [
    "plan path segment too long",
    withValue(
      "canonical_plan_relative_path",
      `docs/${"a".repeat(RELATIVE_PATH_MAX_SEGMENT_BYTES)}.md`,
    ),
    "sdd_pointer_schema",
  ],
  [
    "plan path too long",
    withValue(
      "canonical_plan_relative_path",
      `${"ab/".repeat(6)}${"c".repeat(RELATIVE_PATH_MAX_BYTES)}.md`,
    ),
    "sdd_pointer_schema",
  ],

  // Hex values.
  [
    "commit sha uppercase",
    withValue(
      "canonical_plan_commit_sha",
      EXPECTED_POINTER.canonical_plan_commit_sha.toUpperCase(),
    ),
    "sdd_pointer_schema",
  ],
  [
    "commit sha too short",
    withValue("canonical_plan_commit_sha", "a".repeat(39)),
    "sdd_pointer_schema",
  ],
  [
    "commit sha not hex",
    withValue("canonical_plan_commit_sha", `z${"a".repeat(39)}`),
    "sdd_pointer_schema",
  ],
  [
    "plan hash uppercase",
    withValue(
      "canonical_plan_sha256",
      EXPECTED_POINTER.canonical_plan_sha256.toUpperCase(),
    ),
    "sdd_pointer_schema",
  ],
  [
    "plan hash is 40 hex",
    withValue("canonical_plan_sha256", "a".repeat(40)),
    "sdd_pointer_schema",
  ],
  [
    "receipt hash too short",
    withValue("review_receipt_sha256", "a".repeat(63)),
    "sdd_pointer_schema",
  ],
  [
    "receipt hash not hex",
    withValue("review_receipt_sha256", `g${"a".repeat(63)}`),
    "sdd_pointer_schema",
  ],
];

for (const [name, bytes, expected] of REJECTIONS) {
  test(`rejects ${name} with ${expected}`, () => {
    assert.equal(rejectionCode(bytes), expected);
  });
}

test("every rejection code in the vocabulary is exercised", () => {
  const exercised = new Set(REJECTIONS.map(([, , code]) => code));

  assert.deepEqual([...exercised].sort(), [...SDD_POINTER_CODES].sort());
});
