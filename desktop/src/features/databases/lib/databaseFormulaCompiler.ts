import { Parser } from "expr-eval";

import {
  databaseComputedError,
  type DatabaseComputedError,
} from "./databaseComputedValue";
import type { DatabaseProperty } from "./databaseSchemaCodec";

const MAX_SOURCE_BYTES = 4_096;
const MAX_TOKENS = 512;
const MAX_DEPTH = 32;
const MAX_REFERENCES = 64;
const MAX_CONDITIONALS = 64;
const MAX_LOWERED_BYTES = 16 * 1_024;

export const DATABASE_FORMULA_PUBLIC_FUNCTIONS = [
  "empty",
  "length",
  "substring",
  "contains",
  "lower",
  "upper",
  "trim",
  "format",
  "add",
  "subtract",
  "multiply",
  "divide",
  "mod",
  "pow",
  "min",
  "max",
  "sum",
  "mean",
  "abs",
  "round",
  "ceil",
  "floor",
  "sqrt",
  "pi",
  "toNumber",
  "at",
  "first",
  "last",
  "slice",
  "concat",
  "join",
  "split",
  "includes",
  "id",
  "parseDate",
  "dateRange",
  "dateStart",
  "dateEnd",
  "timestamp",
  "now",
  "today",
  "dateAdd",
  "dateSubtract",
  "dateBetween",
] as const;
const PUBLIC_FUNCTIONS = new Set<string>(DATABASE_FORMULA_PUBLIC_FUNCTIONS);

type TokenKind =
  | "number"
  | "string"
  | "identifier"
  | "operator"
  | "punctuation"
  | "eof";

type Token = {
  kind: TokenKind;
  text: string;
  value?: string | number;
  start: number;
  end: number;
};

type LoweredNode = {
  code: string;
  offsetMap: number[];
  stringLiteral?: string;
  valueType?: StaticFormulaType;
};

export type StaticFormulaType =
  | "boolean"
  | "date"
  | "list"
  | "null"
  | "number"
  | "string"
  | "unknown";

const FUNCTION_ARITY: Record<string, readonly [number, number]> = {
  empty: [1, 1],
  length: [1, 1],
  substring: [2, 3],
  contains: [2, 2],
  lower: [1, 1],
  upper: [1, 1],
  trim: [1, 1],
  format: [1, 1],
  add: [2, 2],
  subtract: [2, 2],
  multiply: [2, 2],
  divide: [2, 2],
  mod: [2, 2],
  pow: [2, 2],
  min: [1, MAX_TOKENS],
  max: [1, MAX_TOKENS],
  sum: [1, MAX_TOKENS],
  mean: [1, MAX_TOKENS],
  abs: [1, 1],
  round: [1, 2],
  ceil: [1, 1],
  floor: [1, 1],
  sqrt: [1, 1],
  pi: [0, 0],
  toNumber: [1, 1],
  at: [2, 2],
  first: [1, 1],
  last: [1, 1],
  slice: [2, 3],
  concat: [1, MAX_TOKENS],
  join: [2, 2],
  split: [2, 2],
  includes: [2, 2],
  id: [0, 0],
  parseDate: [1, 1],
  dateRange: [2, 2],
  dateStart: [1, 1],
  dateEnd: [1, 1],
  timestamp: [1, 1],
  now: [0, 0],
  today: [0, 0],
  dateAdd: [3, 3],
  dateSubtract: [3, 3],
  dateBetween: [3, 3],
};

export type DatabaseFormulaCompilation = {
  source: string;
  lowered: string;
  offsetMap: number[];
  propertyIds: string[];
  resultType: StaticFormulaType;
  usesNow: boolean;
};

export type DatabaseFormulaCompileResult =
  | { ok: true; compilation: DatabaseFormulaCompilation }
  | { ok: false; error: DatabaseComputedError };

class FormulaCompileFailure extends Error {
  readonly code: DatabaseComputedError["code"];
  readonly offset: number;

  constructor(
    code: DatabaseComputedError["code"],
    message: string,
    offset: number,
  ) {
    super(message);
    this.code = code;
    this.offset = offset;
  }
}

function mapped(
  code: string,
  offset: number,
  valueType: StaticFormulaType = "unknown",
): LoweredNode {
  return {
    code,
    offsetMap: Array.from({ length: code.length }, () => offset),
    valueType,
  };
}

function combine(
  parts: Array<LoweredNode | { code: string; offset: number }>,
): LoweredNode {
  let code = "";
  const offsetMap: number[] = [];
  for (const part of parts) {
    code += part.code;
    offsetMap.push(
      ...("offsetMap" in part
        ? part.offsetMap
        : Array.from({ length: part.code.length }, () => part.offset)),
    );
  }
  return { code, offsetMap };
}

function tokenError(message: string, offset: number): never {
  throw new FormulaCompileFailure("SYNTAX", message, offset);
}

function propertyStaticType(property: DatabaseProperty): StaticFormulaType {
  if (["number", "created_time", "last_edited_time"].includes(property.type)) {
    return "number";
  }
  if (property.type === "checkbox") return "boolean";
  if (property.type === "date") return "date";
  if (["multi_select", "person", "relation", "files"].includes(property.type)) {
    return "list";
  }
  if (property.type === "formula" || property.type === "rollup") {
    const resultType = property.options.resultType;
    if (!resultType) return "unknown";
    if (resultType.endsWith("_list")) return "list";
    if (resultType === "text") return "string";
    if (
      resultType === "number" ||
      resultType === "boolean" ||
      resultType === "date"
    ) {
      return resultType;
    }
    return "unknown";
  }
  return "string";
}

function requireStaticType(
  node: LoweredNode,
  allowed: readonly StaticFormulaType[],
  offset: number,
  name: string,
): void {
  const type = node.valueType ?? "unknown";
  if (type !== "unknown" && !allowed.includes(type)) {
    throw new FormulaCompileFailure(
      "TYPE_MISMATCH",
      `${name} cannot use a known ${type} value.`,
      offset,
    );
  }
}

function validateStaticCall(
  name: string,
  args: LoweredNode[],
  offset: number,
): void {
  if (["__bool", "__not"].includes(name)) {
    requireStaticType(args[0], ["boolean"], offset, name);
    return;
  }
  if (["__positive", "__negative"].includes(name)) {
    requireStaticType(args[0], ["number"], offset, name);
    return;
  }
  const binaryNumbers = new Set([
    "__add",
    "__subtract",
    "__multiply",
    "__divide",
    "__mod",
    "__pow",
    "add",
    "subtract",
    "multiply",
    "divide",
    "mod",
    "pow",
  ]);
  if (binaryNumbers.has(name)) {
    args.forEach((argument) => {
      requireStaticType(argument, ["number"], offset, name);
    });
    return;
  }
  if (["__eq", "__ne"].includes(name)) {
    const left = args[0]?.valueType ?? "unknown";
    const right = args[1]?.valueType ?? "unknown";
    if (left !== "unknown" && right !== "unknown" && left !== right) {
      throw new FormulaCompileFailure(
        "TYPE_MISMATCH",
        "Equality requires matching known types.",
        offset,
      );
    }
    return;
  }
  if (["__gt", "__gte", "__lt", "__lte"].includes(name)) {
    args.forEach((argument) => {
      requireStaticType(argument, ["number", "string", "date"], offset, name);
    });
    const left = args[0]?.valueType ?? "unknown";
    const right = args[1]?.valueType ?? "unknown";
    if (left !== "unknown" && right !== "unknown" && left !== right) {
      throw new FormulaCompileFailure(
        "TYPE_MISMATCH",
        "Ordering requires matching known types.",
        offset,
      );
    }
    return;
  }
  const numericFirst = new Set(["abs", "round", "ceil", "floor", "sqrt"]);
  if (numericFirst.has(name)) {
    requireStaticType(args[0], ["number"], offset, name);
    if (name === "round" && args[1]) {
      requireStaticType(args[1], ["number"], offset, name);
    }
    return;
  }
  if (["min", "max", "sum", "mean"].includes(name)) {
    args.forEach((argument) => {
      requireStaticType(argument, ["number", "list", "null"], offset, name);
    });
    return;
  }
  if (["lower", "upper", "trim"].includes(name)) {
    requireStaticType(args[0], ["string"], offset, name);
    return;
  }
  if (name === "substring") {
    requireStaticType(args[0], ["string"], offset, name);
    args.slice(1).forEach((argument) => {
      requireStaticType(argument, ["number"], offset, name);
    });
    return;
  }
  if (["length", "contains"].includes(name)) {
    requireStaticType(args[0], ["string", "list"], offset, name);
    return;
  }
  if (["at", "slice"].includes(name)) {
    requireStaticType(args[0], ["list"], offset, name);
    args.slice(1).forEach((argument) => {
      requireStaticType(argument, ["number"], offset, name);
    });
    return;
  }
  if (["first", "last", "concat", "includes"].includes(name)) {
    requireStaticType(args[0], ["list"], offset, name);
    if (name === "concat") {
      args.forEach((argument) => {
        requireStaticType(argument, ["list"], offset, name);
      });
    }
    return;
  }
  if (name === "join") {
    requireStaticType(args[0], ["list"], offset, name);
    requireStaticType(args[1], ["string"], offset, name);
    return;
  }
  if (name === "split") {
    args.forEach((argument) => {
      requireStaticType(argument, ["string"], offset, name);
    });
    return;
  }
  if (name === "parseDate") {
    requireStaticType(args[0], ["string"], offset, name);
    return;
  }
  if (["dateRange"].includes(name)) {
    args.forEach((argument) => {
      requireStaticType(argument, ["date"], offset, name);
    });
    return;
  }
  if (["dateStart", "dateEnd", "timestamp"].includes(name)) {
    requireStaticType(args[0], ["date"], offset, name);
    return;
  }
  if (["dateAdd", "dateSubtract"].includes(name)) {
    requireStaticType(args[0], ["date"], offset, name);
    requireStaticType(args[1], ["number"], offset, name);
    requireStaticType(args[2], ["string"], offset, name);
    return;
  }
  if (name === "dateBetween") {
    requireStaticType(args[0], ["date"], offset, name);
    requireStaticType(args[1], ["date"], offset, name);
    requireStaticType(args[2], ["string"], offset, name);
  }
}

function staticCallResult(name: string): StaticFormulaType {
  if (
    [
      "__bool",
      "__not",
      "__eq",
      "__ne",
      "__gt",
      "__gte",
      "__lt",
      "__lte",
      "empty",
      "contains",
      "includes",
    ].includes(name)
  )
    return "boolean";
  if (
    [
      "__add",
      "__subtract",
      "__multiply",
      "__divide",
      "__mod",
      "__pow",
      "__positive",
      "__negative",
      "length",
      "add",
      "subtract",
      "multiply",
      "divide",
      "mod",
      "pow",
      "min",
      "max",
      "sum",
      "mean",
      "abs",
      "round",
      "ceil",
      "floor",
      "sqrt",
      "pi",
      "toNumber",
      "timestamp",
      "dateBetween",
    ].includes(name)
  )
    return "number";
  if (
    ["substring", "lower", "upper", "trim", "format", "join", "id"].includes(
      name,
    )
  ) {
    return "string";
  }
  if (["slice", "concat", "split"].includes(name)) return "list";
  if (
    [
      "parseDate",
      "dateRange",
      "dateStart",
      "dateEnd",
      "now",
      "today",
      "dateAdd",
      "dateSubtract",
    ].includes(name)
  )
    return "date";
  if (name === "__null") return "null";
  return "unknown";
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MAX_TOKENS) {
      throw new FormulaCompileFailure(
        "TOO_COMPLEX",
        `Formula has more than ${MAX_TOKENS} tokens.`,
        token.start,
      );
    }
  };
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    const start = index;
    if (character === '"' || character === "'") {
      const quote = character;
      index += 1;
      let value = "";
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (current === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) tokenError("Unclosed escape.", index);
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            '"': '"',
            "'": "'",
          };
          if (!(escaped in escapes)) {
            tokenError(`Unsupported escape \\${escaped}.`, index);
          }
          value += escapes[escaped];
          index += 2;
          continue;
        }
        value += current;
        index += 1;
      }
      if (!closed) tokenError("Unclosed string.", start);
      push({
        kind: "string",
        text: source.slice(start, index),
        value,
        start,
        end: index,
      });
      continue;
    }
    if (
      /\d/u.test(character) ||
      (character === "." && /\d/u.test(source[index + 1] ?? ""))
    ) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(
        source.slice(index),
      );
      if (!match) tokenError("Invalid number.", start);
      index += match[0].length;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) {
        throw new FormulaCompileFailure(
          "NON_FINITE",
          "Formula number must be finite.",
          start,
        );
      }
      push({
        kind: "number",
        text: match[0],
        value,
        start,
        end: index,
      });
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
      if (!match) tokenError("Invalid identifier.", start);
      index += match[0].length;
      push({
        kind: "identifier",
        text: match[0],
        value: match[0],
        start,
        end: index,
      });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(pair)) {
      if (pair === "&&" || pair === "||") {
        tokenError(
          `Use ${pair === "&&" ? "and" : "or"} instead of ${pair}.`,
          start,
        );
      }
      index += 2;
      push({ kind: "operator", text: pair, start, end: index });
      continue;
    }
    if ("+-*/%^><!?=:".includes(character)) {
      if (character === "!" || character === "=") {
        tokenError(`Unsupported operator ${character}.`, start);
      }
      index += 1;
      push({ kind: "operator", text: character, start, end: index });
      continue;
    }
    if ("(),[]".includes(character)) {
      index += 1;
      push({ kind: "punctuation", text: character, start, end: index });
      continue;
    }
    tokenError(`Unsupported character ${character}.`, start);
  }
  push({ kind: "eof", text: "", start: source.length, end: source.length });
  return tokens;
}

class FormulaParser {
  private index = 0;
  private depth = 0;
  private conditionals = 0;
  private readonly propertyIds: string[] = [];
  private readonly propertyIndexes = new Map<string, number>();
  private readonly propertiesByName: ReadonlyMap<string, DatabaseProperty[]>;
  private readonly tokens: Token[];
  usesNow = false;

  constructor(
    tokens: Token[],
    propertiesByName: ReadonlyMap<string, DatabaseProperty[]>,
  ) {
    this.tokens = tokens;
    this.propertiesByName = propertiesByName;
  }

  compilation(source: string): DatabaseFormulaCompilation {
    const node = this.ternary();
    if (this.peek().kind !== "eof") {
      tokenError(`Unexpected ${this.peek().text}.`, this.peek().start);
    }
    if (new TextEncoder().encode(node.code).length > MAX_LOWERED_BYTES) {
      throw new FormulaCompileFailure(
        "TOO_COMPLEX",
        `Lowered formula is larger than ${MAX_LOWERED_BYTES} bytes.`,
        source.length,
      );
    }
    validateLoweredSyntax(node.code, node.offsetMap);
    return {
      source,
      lowered: node.code,
      offsetMap: node.offsetMap,
      propertyIds: this.propertyIds,
      resultType: node.valueType ?? "unknown",
      usesNow: this.usesNow,
    };
  }

  private peek(): Token {
    return this.tokens[this.index];
  }

  private take(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private match(text: string): Token | null {
    if (this.peek().text !== text) return null;
    return this.take();
  }

  private expect(text: string): Token {
    return (
      this.match(text) ?? tokenError(`Expected ${text}.`, this.peek().start)
    );
  }

  private nested<T>(offset: number, run: () => T): T {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaCompileFailure(
        "TOO_COMPLEX",
        `Formula nesting exceeds ${MAX_DEPTH}.`,
        offset,
      );
    }
    try {
      return run();
    } finally {
      this.depth -= 1;
    }
  }

  private ternary(): LoweredNode {
    const condition = this.or();
    const question = this.match("?");
    if (!question) return condition;
    this.countConditional(question.start);
    const whenTrue = this.ternary();
    this.expect(":");
    const whenFalse = this.ternary();
    requireStaticType(condition, ["boolean"], question.start, "condition");
    return {
      ...combine([
        { code: "(__bool(", offset: question.start },
        condition,
        { code: ")?(", offset: question.start },
        whenTrue,
        { code: "):(", offset: question.start },
        whenFalse,
        { code: "))", offset: question.start },
      ]),
      valueType:
        whenTrue.valueType === whenFalse.valueType
          ? whenTrue.valueType
          : "unknown",
    };
  }

  private or(): LoweredNode {
    let left = this.and();
    while (this.peek().text === "or") {
      const operator = this.take();
      const right = this.and();
      requireStaticType(left, ["boolean"], operator.start, "or");
      requireStaticType(right, ["boolean"], operator.start, "or");
      left = {
        ...combine([
          { code: "(__bool(", offset: operator.start },
          left,
          { code: ")?true:__bool(", offset: operator.start },
          right,
          { code: "))", offset: operator.start },
        ]),
        valueType: "boolean",
      };
    }
    return left;
  }

  private and(): LoweredNode {
    let left = this.comparison();
    while (this.peek().text === "and") {
      const operator = this.take();
      const right = this.comparison();
      requireStaticType(left, ["boolean"], operator.start, "and");
      requireStaticType(right, ["boolean"], operator.start, "and");
      left = {
        ...combine([
          { code: "(__bool(", offset: operator.start },
          left,
          { code: ")?__bool(", offset: operator.start },
          right,
          { code: "):false)", offset: operator.start },
        ]),
        valueType: "boolean",
      };
    }
    return left;
  }

  private comparison(): LoweredNode {
    let left = this.additive();
    const names: Record<string, string> = {
      "==": "__eq",
      "!=": "__ne",
      ">": "__gt",
      ">=": "__gte",
      "<": "__lt",
      "<=": "__lte",
    };
    while (names[this.peek().text]) {
      const operator = this.take();
      const right = this.additive();
      left = this.call(names[operator.text], [left, right], operator.start);
    }
    return left;
  }

  private additive(): LoweredNode {
    let left = this.multiplicative();
    while (this.peek().text === "+" || this.peek().text === "-") {
      const operator = this.take();
      const right = this.multiplicative();
      left = this.call(
        operator.text === "+" ? "__add" : "__subtract",
        [left, right],
        operator.start,
      );
    }
    return left;
  }

  private multiplicative(): LoweredNode {
    let left = this.unary();
    const names: Record<string, string> = {
      "*": "__multiply",
      "/": "__divide",
      "%": "__mod",
    };
    while (names[this.peek().text]) {
      const operator = this.take();
      const right = this.unary();
      left = this.call(names[operator.text], [left, right], operator.start);
    }
    return left;
  }

  private power(): LoweredNode {
    const left = this.primary();
    const operator = this.match("^");
    if (!operator) return left;
    return this.call("__pow", [left, this.unary()], operator.start);
  }

  private unary(): LoweredNode {
    const token = this.peek();
    if (token.text === "not" || token.text === "+" || token.text === "-") {
      this.take();
      const name =
        token.text === "not"
          ? "__not"
          : token.text === "+"
            ? "__positive"
            : "__negative";
      return this.call(name, [this.unary()], token.start);
    }
    return this.power();
  }

  private primary(): LoweredNode {
    const token = this.take();
    if (token.kind === "number")
      return mapped(token.text, token.start, "number");
    if (token.kind === "string") {
      const literal = mapped(
        JSON.stringify(token.value),
        token.start,
        "string",
      );
      literal.stringLiteral = token.value as string;
      return literal;
    }
    if (token.text === "(") {
      return this.nested(token.start, () => {
        const value = this.ternary();
        this.expect(")");
        return {
          ...combine([
            { code: "(", offset: token.start },
            value,
            { code: ")", offset: token.start },
          ]),
          valueType: value.valueType,
        };
      });
    }
    if (token.text === "[") {
      return this.nested(token.start, () => {
        const values: LoweredNode[] = [];
        if (!this.match("]")) {
          do values.push(this.ternary());
          while (this.match(","));
          this.expect("]");
        }
        const parts: Array<LoweredNode | { code: string; offset: number }> = [
          { code: "[", offset: token.start },
        ];
        values.forEach((value, index) => {
          if (index) parts.push({ code: ",", offset: token.start });
          parts.push(value);
        });
        parts.push({ code: "]", offset: token.start });
        return { ...combine(parts), valueType: "list" };
      });
    }
    if (token.kind !== "identifier") {
      tokenError(
        `Expected a value, found ${token.text || "end of formula"}.`,
        token.start,
      );
    }
    if (["true", "false"].includes(token.text) && this.peek().text !== "(") {
      return mapped(token.text, token.start, "boolean");
    }
    if (token.text === "null" && this.peek().text !== "(") {
      return { ...this.call("__null", [], token.start), valueType: "null" };
    }
    if (this.peek().text !== "(") {
      tokenError(`Unknown name ${token.text}.`, token.start);
    }
    return this.functionCall(token);
  }

  private functionCall(name: Token): LoweredNode {
    this.expect("(");
    const args = this.nested(name.start, () => {
      const values: LoweredNode[] = [];
      if (!this.match(")")) {
        do values.push(this.ternary());
        while (this.match(","));
        this.expect(")");
      }
      return values;
    });
    if (name.text === "prop") return this.propertyCall(name, args);
    if (name.text === "if") {
      if (args.length !== 3) {
        tokenError("if requires exactly three arguments.", name.start);
      }
      requireStaticType(args[0], ["boolean"], name.start, "if");
      this.countConditional(name.start);
      return {
        ...combine([
          { code: "(__bool(", offset: name.start },
          args[0],
          { code: ")?(", offset: name.start },
          args[1],
          { code: "):(", offset: name.start },
          args[2],
          { code: "))", offset: name.start },
        ]),
        valueType:
          args[1].valueType === args[2].valueType
            ? args[1].valueType
            : "unknown",
      };
    }
    if (name.text === "ifs") {
      if (args.length < 3 || args.length % 2 === 0) {
        tokenError(
          "ifs requires condition/value pairs and a fallback.",
          name.start,
        );
      }
      let result = args.at(-1) as LoweredNode;
      for (let index = args.length - 3; index >= 0; index -= 2) {
        requireStaticType(args[index], ["boolean"], name.start, "ifs");
        this.countConditional(name.start);
        result = {
          ...combine([
            { code: "(__bool(", offset: name.start },
            args[index],
            { code: ")?(", offset: name.start },
            args[index + 1],
            { code: "):(", offset: name.start },
            result,
            { code: "))", offset: name.start },
          ]),
          valueType:
            args[index + 1].valueType === result.valueType
              ? result.valueType
              : "unknown",
        };
      }
      return result;
    }
    if (!PUBLIC_FUNCTIONS.has(name.text)) {
      throw new FormulaCompileFailure(
        "UNSUPPORTED_FUNCTION",
        `Function ${name.text} is not supported.`,
        name.start,
      );
    }
    const [minimum, maximum] = FUNCTION_ARITY[name.text];
    if (args.length < minimum || args.length > maximum) {
      throw new FormulaCompileFailure(
        "TYPE_MISMATCH",
        `${name.text} requires ${minimum}${minimum === maximum ? "" : `-${maximum}`} arguments.`,
        name.start,
      );
    }
    if (name.text === "now" || name.text === "today") this.usesNow = true;
    return this.call(name.text, args, name.start);
  }

  private propertyCall(name: Token, args: LoweredNode[]): LoweredNode {
    if (args.length !== 1 || args[0].stringLiteral === undefined) {
      tokenError("prop requires one literal property name.", name.start);
    }
    const propertyName = args[0].stringLiteral;
    const matches = this.propertiesByName.get(propertyName) ?? [];
    if (!matches.length) {
      throw new FormulaCompileFailure(
        "UNKNOWN_PROPERTY",
        `Property ${propertyName} does not exist.`,
        name.start,
      );
    }
    if (matches.length > 1) {
      throw new FormulaCompileFailure(
        "AMBIGUOUS_PROPERTY",
        `Property ${propertyName} matches ${matches.map(({ id }) => id).join(", ")}.`,
        name.start,
      );
    }
    const propertyId = matches[0].id;
    let index = this.propertyIndexes.get(propertyId);
    if (index === undefined) {
      index = this.propertyIds.length;
      this.propertyIndexes.set(propertyId, index);
      this.propertyIds.push(propertyId);
      if (this.propertyIds.length > MAX_REFERENCES) {
        throw new FormulaCompileFailure(
          "TOO_COMPLEX",
          `Formula references more than ${MAX_REFERENCES} properties.`,
          name.start,
        );
      }
    }
    return {
      ...this.call(
        "__prop",
        [mapped(String(index), name.start, "number")],
        name.start,
      ),
      valueType: propertyStaticType(matches[0]),
    };
  }

  private call(name: string, args: LoweredNode[], offset: number): LoweredNode {
    validateStaticCall(name, args, offset);
    const parts: Array<LoweredNode | { code: string; offset: number }> = [
      { code: `${name}(`, offset },
    ];
    args.forEach((argument, index) => {
      if (index) parts.push({ code: ",", offset });
      parts.push(argument);
    });
    parts.push({ code: ")", offset });
    return { ...combine(parts), valueType: staticCallResult(name) };
  }

  private countConditional(offset: number): void {
    this.conditionals += 1;
    if (this.conditionals > MAX_CONDITIONALS) {
      throw new FormulaCompileFailure(
        "TOO_COMPLEX",
        `Formula has more than ${MAX_CONDITIONALS} conditionals.`,
        offset,
      );
    }
  }
}

function parserOptions() {
  return {
    allowMemberAccess: false,
    operators: {
      add: false,
      comparison: false,
      concatenate: false,
      conditional: true,
      divide: false,
      factorial: false,
      logical: false,
      multiply: false,
      power: false,
      remainder: false,
      subtract: false,
      sin: false,
      cos: false,
      tan: false,
      asin: false,
      acos: false,
      atan: false,
      sinh: false,
      cosh: false,
      tanh: false,
      asinh: false,
      acosh: false,
      atanh: false,
      sqrt: false,
      log: false,
      ln: false,
      lg: false,
      log10: false,
      abs: false,
      ceil: false,
      floor: false,
      round: false,
      trunc: false,
      exp: false,
      length: false,
      in: false,
      random: false,
      min: false,
      max: false,
      assignment: false,
      fndef: false,
      cbrt: false,
      expm1: false,
      log1p: false,
      sign: false,
      log2: false,
    },
  } as const;
}

function validateLoweredSyntax(lowered: string, offsetMap: number[]): void {
  const parser = new Parser(parserOptions());
  parser.functions = new Proxy(
    Object.create(null) as Record<string, () => null>,
    {
      get: (target, key: string) => target[key] ?? (() => null),
      has: () => true,
    },
  );
  parser.consts = { true: true, false: false };
  try {
    parser.parse(lowered);
  } catch (error) {
    const match = /at character (\d+)/u.exec(
      error instanceof Error ? error.message : String(error),
    );
    const loweredOffset = match ? Number(match[1]) : 0;
    const sourceOffset = offsetMap[Math.max(0, loweredOffset - 1)] ?? 0;
    throw new FormulaCompileFailure(
      "SYNTAX",
      error instanceof Error ? error.message : "Invalid formula syntax.",
      sourceOffset,
    );
  }
}

/** Compiles one bounded user formula to strict Buzz adapter calls. */
export function compileDatabaseFormula(
  source: string,
  properties: readonly DatabaseProperty[],
): DatabaseFormulaCompileResult {
  try {
    if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
      throw new FormulaCompileFailure(
        "TOO_COMPLEX",
        `Formula is larger than ${MAX_SOURCE_BYTES} bytes.`,
        0,
      );
    }
    const propertiesByName = new Map<string, DatabaseProperty[]>();
    for (const property of properties) {
      propertiesByName.set(property.name, [
        ...(propertiesByName.get(property.name) ?? []),
        property,
      ]);
    }
    const compilation = new FormulaParser(
      tokenize(source),
      propertiesByName,
    ).compilation(source);
    return { ok: true, compilation };
  } catch (error) {
    if (error instanceof FormulaCompileFailure) {
      return {
        ok: false,
        error: databaseComputedError(
          error.code,
          `${error.message} (at ${error.offset})`,
        ),
      };
    }
    return {
      ok: false,
      error: databaseComputedError(
        "SYNTAX",
        error instanceof Error ? error.message : "Invalid formula.",
      ),
    };
  }
}

/** Parser options shared with the production evaluator. */
export const DATABASE_FORMULA_PARSER_OPTIONS = parserOptions();
