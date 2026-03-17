import {
  autocompletion,
  Completion,
  CompletionContext,
  snippetCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { Diagnostic, lintGutter, linter } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  DefinitionsResult,
  Environment,
  serialize,
} from "@marcbachmann/cel-js";
import { basicSetup } from "codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

type CelTypeFields = Record<string, string>;

const lineFields: CelTypeFields = {
  sku: "string",
  qty: "int",
  unitPrice: "int",
  category: "string",
};

const destinationFields: CelTypeFields = {
  country: "string",
  city: "string",
};

const customerFields: CelTypeFields = {
  name: "string",
  tier: "string",
  vip: "bool",
  region: "string",
};

const orderFields: CelTypeFields = {
  id: "string",
  baseFee: "int",
  notes: "list<string>",
  destination: "Destination",
  lines: "list<Line>",
};

const typeFieldMap: Record<string, CelTypeFields> = {
  Customer: customerFields,
  Destination: destinationFields,
  Line: lineFields,
  Order: orderFields,
};

const rootBindingTypes: Record<string, string> = {
  customer: "Customer",
  order: "Order",
  catalog: "map",
  DEFAULT_TAX_PERCENT: "int",
  cel: "CelNamespace",
  optional: "OptionalNamespace",
  google: "map<string, map<string, type>>",
};

const builtInGlobalFunctionNames = new Set(["has", "size"]);
const autocompleteSentinel = "__autocomplete__";

const typeFieldDescriptions: Record<string, Record<string, string>> = {
  Customer: {
    name: "Customer display name used in output and personalization rules.",
    tier: "Tier string used by pricing rules such as tierDiscount(...).",
    vip: "Boolean flag for VIP-only rules and branches.",
    region: "Customer region identifier used for routing or pricing.",
  },
  Destination: {
    country: "Two-letter destination country code.",
    city: "Destination city name.",
  },
  Line: {
    sku: "Catalog SKU for the line item.",
    qty: "Ordered quantity for the line item.",
    unitPrice: "Unit price in cents.",
    category: "Line category used by examples like filter(...).",
  },
  Order: {
    id: "Order identifier.",
    baseFee: "Base fee in cents added to the subtotal.",
    notes: "Free-form notes attached to the order.",
    destination: "Destination object for delivery details.",
    lines: "Order line items as list<Line>.",
  },
};

const builtinVariableDescriptions: Record<string, string> = {
  cel: "Built-in CEL namespace. Use receiver methods like cel.bind(...) for scoped bindings.",
  optional:
    "Built-in namespace for working with optional values and helper constructors.",
  google: "Built-in namespace containing registered protobuf types.",
};

type RichFunctionDoc = {
  description: string;
  examples?: string[];
  params?: Array<{
    name: string;
    type: string;
    description: string;
  }>;
};

const functionDocumentation: Record<string, RichFunctionDoc> = {
  "global:has": {
    description:
      "Checks whether a field access path is present without throwing on missing keys.",
    examples: ['has(order.destination.city)', 'has(customer.region)'],
  },
  "global:size": {
    description:
      "Returns the size of a string, bytes value, list, or map depending on the overload.",
    examples: ['size(order.notes)', 'size(customer.name)'],
  },
  "list<dyn>:all": {
    description:
      "Returns true when every element in the list satisfies the predicate.",
    examples: ["order.lines.all(l, l.qty >= 1)"],
  },
  "list<dyn>:exists": {
    description:
      "Returns true when at least one element in the list satisfies the predicate.",
    examples: ["order.lines.exists(l, l.category == 'fragile')"],
  },
  "list<dyn>:exists_one": {
    description:
      "Returns true when exactly one element in the list satisfies the predicate.",
  },
  "list<dyn>:filter": {
    description:
      "Creates a new list containing only the elements that satisfy the predicate.",
    examples: ["order.lines.filter(l, l.category == 'fragile')"],
  },
  "list<dyn>:map": {
    description:
      "Transforms list elements into a new list. The 3-argument overload accepts an inline filter predicate.",
    examples: ["order.lines.map(l, lineTotal(l))", "order.lines.map(l, l.qty > 1, l.sku)"],
  },
  "CelNamespace:bind": {
    description:
      "Binds a temporary identifier for the rest of an expression. The first argument is an identifier AST, not a string literal.",
    params: [
      {
        name: "name",
        type: "ast",
        description: "Identifier to introduce into the bound expression scope.",
      },
      {
        name: "value",
        type: "dyn",
        description: "Value assigned to the identifier.",
      },
      {
        name: "expr",
        type: "ast",
        description: "Expression evaluated with the temporary binding in scope.",
      },
    ],
    examples: ["cel.bind(total, sum(order.lines.map(l, lineTotal(l))), money(total))"],
  },
  "OptionalNamespace:none": {
    description: "Creates an empty optional value.",
  },
  "OptionalNamespace:of": {
    description: "Wraps a value inside an optional.",
    params: [
      {
        name: "value",
        type: "A",
        description: "Value to wrap as an optional.",
      },
    ],
    examples: ['optional.of("hello")'],
  },
};

const celKeywords = [
  { label: "true", type: "keyword", detail: "bool", boost: 30 },
  { label: "false", type: "keyword", detail: "bool", boost: 30 },
  { label: "null", type: "keyword", detail: "null", boost: 20 },
  { label: "in", type: "keyword", detail: "operator", boost: 10 },
];

const completionSections = {
  globals: { name: "Globals", rank: 0 },
  locals: { name: "Locals", rank: 1 },
  functions: { name: "Functions", rank: 2 },
  properties: { name: "Properties", rank: 3 },
  methods: { name: "Methods", rank: 4 },
  keywords: { name: "Keywords", rank: 5 },
} as const;

const celLanguage = StreamLanguage.define({
  startState() {
    return { afterDot: false };
  },
  token(stream, state) {
    if (stream.eatSpace()) return null;

    if (stream.match("//")) {
      stream.skipToEnd();
      state.afterDot = false;
      return "comment";
    }

    const ch = stream.peek();
    if (!ch) return null;

    if (ch === '"' || ch === "'") {
      const quote = stream.next();
      let escaped = false;
      while (!stream.eol()) {
        const next = stream.next();
        if (escaped) {
          escaped = false;
          continue;
        }
        if (next === "\\") {
          escaped = true;
          continue;
        }
        if (next === quote) break;
      }
      state.afterDot = false;
      return "string";
    }

    if (stream.match(/^\d+(?:\.\d+)?(?:e[+-]?\d+)?u?/i)) {
      state.afterDot = false;
      return "number";
    }

    if (stream.match(/^(?:true|false|null)\b/)) {
      state.afterDot = false;
      return "atom";
    }

    if (stream.match(/^(?:in|has|all|exists|exists_one|filter|map)\b/)) {
      state.afterDot = false;
      return "keyword";
    }

    if (stream.eat(".")) {
      state.afterDot = true;
      return "punctuation";
    }

    if (stream.match(/^[()[\]{},]/)) {
      state.afterDot = false;
      return "punctuation";
    }

    if (stream.match(/^(?:==|!=|<=|>=|&&|\|\||[+\-*/%?:=!<>])/)) {
      state.afterDot = false;
      return "operator";
    }

    if (stream.match(/^[A-Z][\w.]*/)) {
      state.afterDot = false;
      return "typeName";
    }

    if (stream.match(/^[A-Za-z_]\w*/)) {
      const style = state.afterDot ? "propertyName" : "variableName";
      state.afterDot = false;
      return style;
    }

    stream.next();
    state.afterDot = false;
    return null;
  },
});

const celHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#fbbf24", fontWeight: "600" },
  { tag: tags.atom, color: "#fda4af", fontWeight: "600" },
  { tag: tags.string, color: "#86efac" },
  { tag: tags.number, color: "#7dd3fc" },
  { tag: tags.typeName, color: "#93c5fd" },
  { tag: tags.propertyName, color: "#c4b5fd" },
  { tag: tags.variableName, color: "#e5e7eb" },
  { tag: tags.operator, color: "#f8fafc" },
  { tag: tags.comment, color: "#64748b", fontStyle: "italic" },
  { tag: tags.punctuation, color: "#94a3b8" },
]);

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  return 0n;
}

function formatMoney(cents: bigint) {
  return new Intl.NumberFormat("en-DE", {
    style: "currency",
    currency: "EUR",
  }).format(Number(cents) / 100);
}

function stringify(value: unknown) {
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === "bigint") return `${current}n`;
      if (current instanceof Uint8Array) return Array.from(current);
      return current;
    },
    2,
  );
}

function formatResult(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value == null) return String(value);
  return stringify(value);
}

function buildEnvironment() {
  const env = new Environment({
    homogeneousAggregateLiterals: false,
  });

  env.registerType("Line", { fields: lineFields });
  env.registerType("Destination", { fields: destinationFields });
  env.registerType("Customer", { fields: customerFields });
  env.registerType("Order", { fields: orderFields });

  env.registerVariable("customer", "Customer", {
    description: "Customer profile for the current order",
  });

  env.registerVariable("order", "Order", {
    description: "Current order payload",
  });

  env.registerVariable("catalog", "map", {
    description: "Price lookup table by SKU in cents",
  });

  env.registerConstant({
    name: "DEFAULT_TAX_PERCENT",
    type: "int",
    value: 19n,
    description: "Default VAT percentage",
  });

  env.registerFunction({
    signature: "percent(int, int): int",
    handler: (value, pct) => (toBigInt(value) * toBigInt(pct)) / 100n,
    description: "Returns pct percent of value",
    params: [
      { name: "value", type: "int", description: "Base amount in cents" },
      { name: "pct", type: "int", description: "Percentage, e.g. 15" },
    ],
  });

  env.registerFunction({
    signature: "lineTotal(Line): int",
    handler: (line) => toBigInt(line.qty) * toBigInt(line.unitPrice),
    description: "qty * unitPrice for a single order line",
    params: [{ name: "line", type: "Line", description: "An order line" }],
  });

  env.registerFunction({
    signature: "sum(list): int",
    handler: (values) =>
      Array.isArray(values)
        ? values.reduce((acc, item) => acc + toBigInt(item), 0n)
        : 0n,
    description: "Sums a list of ints",
    params: [
      { name: "values", type: "list", description: "List of integer values" },
    ],
  });

  env.registerFunction({
    signature: "tierDiscount(string, int): int",
    handler: (tier: string, subtotal: number) => {
      const pctByTier: Record<string, bigint> = {
        bronze: 0n,
        silver: 5n,
        gold: 10n,
        platinum: 15n,
      };
      return (toBigInt(subtotal) * (pctByTier[tier] ?? 0n)) / 100n;
    },
    description: "Returns discount amount from customer tier and subtotal",
    params: [
      {
        name: "tier",
        type: "string",
        description: "bronze | silver | gold | platinum",
      },
      { name: "subtotal", type: "int", description: "Subtotal in cents" },
    ],
  });

  env.registerFunction({
    signature: "lookupPrice(string, map): int",
    handler: (sku, catalog) => toBigInt(catalog?.[sku] ?? 0n),
    description: "Looks up a unit price from the catalog map",
    params: [
      { name: "sku", type: "string", description: "SKU key" },
      { name: "catalog", type: "map", description: "SKU -> cents" },
    ],
  });

  env.registerFunction({
    signature: "money(int): string",
    handler: (cents) => formatMoney(toBigInt(cents)),
    description: "Formats cents as an EUR currency string",
    params: [{ name: "cents", type: "int", description: "Amount in cents" }],
  });

  env.registerFunction({
    name: "shout",
    receiverType: "string",
    returnType: "string",
    handler: (value) => `${String(value).toUpperCase()}!`,
    description:
      "Receiver method: uppercases a string and adds an exclamation mark",
    params: [],
  });

  return env;
}

const sampleData = {
  customer: {
    name: "Anton Logistics",
    tier: "gold",
    vip: true,
    region: "eu-central",
  },
  order: {
    id: "ORD-2026-001",
    baseFee: 1299n,
    notes: ["call before delivery", "dock 3"],
    destination: {
      country: "DE",
      city: "Fulda",
    },
    lines: [
      { sku: "SKU-1", qty: 2n, unitPrice: 1599n, category: "fragile" },
      { sku: "SKU-2", qty: 5n, unitPrice: 499n, category: "standard" },
      { sku: "SKU-3", qty: 1n, unitPrice: 10999n, category: "oversized" },
    ],
  },
  catalog: {
    "SKU-1": 1599n,
    "SKU-2": 499n,
    "SKU-3": 10999n,
    "SKU-4": 2499n,
  },
};

const examples = [
  {
    title: "Boolean rule",
    expression:
      'customer.vip && order.destination.country == "DE" && order.lines.exists(l, l.qty >= 2)',
  },
  {
    title: "List projection with macros",
    expression: 'order.lines.filter(l, l.category == "fragile").map(l, l.sku)',
  },
  {
    title: "Lookup table",
    expression: 'lookupPrice("SKU-2", catalog)',
  },
  {
    title: "Subtotal from lines + base fee",
    expression: "money(sum(order.lines.map(l, lineTotal(l))) + order.baseFee)",
  },
  {
    title: "Tier discount",
    expression:
      "money(sum(order.lines.map(l, lineTotal(l))) - tierDiscount(customer.tier, sum(order.lines.map(l, lineTotal(l)))))",
  },
  {
    title: "Tax amount",
    expression:
      "money(percent(sum(order.lines.map(l, lineTotal(l))), DEFAULT_TAX_PERCENT))",
  },
  {
    title: "Receiver method + ternary",
    expression: "customer.vip ? customer.name.shout() : customer.name",
  },
  {
    title: "Notes info",
    expression: 'size(order.notes) > 0 ? order.notes[0] : "no notes"',
  },
];

function signatureArgs(definition: DefinitionsResult["functions"][number]) {
  return getFunctionParams(definition).map((param) => param.name).join(", ");
}

function buildFunctionLabel(definition: DefinitionsResult["functions"][number]) {
  return definition.receiverType
    ? `${definition.receiverType}.${definition.name}(${signatureArgs(definition)})`
    : `${definition.name}(${signatureArgs(definition)})`;
}

function baseTypeName(typeName: string) {
  const genericsIndex = typeName.indexOf("<");
  return genericsIndex === -1 ? typeName : typeName.slice(0, genericsIndex);
}

function listElementType(typeName: string) {
  const match = typeName.match(/^list<(.+)>$/);
  return match?.[1] ?? null;
}

function isGenericReceiverType(typeName: string) {
  return /<(?:dyn|[A-Z][^>]*)>/.test(typeName);
}

function receiverMatches(receiverType: string, actualType: string) {
  if (receiverType === actualType) return true;
  if (baseTypeName(receiverType) !== baseTypeName(actualType)) return false;
  return isGenericReceiverType(receiverType);
}

function resolveTypeFields(typeName: string) {
  return typeFieldMap[typeName] ?? null;
}

function buildSnippetTemplate(
  definition: DefinitionsResult["functions"][number],
) {
  const { name } = definition;
  const params = getFunctionParams(definition);
  if (params.length === 0) return `${name}()`;
  const placeholders = params.map((param, index) => {
    const placeholderName = param.name || `arg${index + 1}`;
    return `\${${index + 1}:${placeholderName}}`;
  });
  return `${name}(${placeholders.join(", ")})`;
}

function groupFunctions(functions: DefinitionsResult["functions"]) {
  const grouped = new Map<
    string,
    {
      name: string;
      receiverType: string | null;
      overloads: DefinitionsResult["functions"];
    }
  >();

  for (const definition of functions) {
    const key = `${definition.receiverType ?? "global"}:${definition.name}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.overloads.push(definition);
      continue;
    }

    grouped.set(key, {
      name: definition.name,
      receiverType: definition.receiverType,
      overloads: [definition],
    });
  }

  return Array.from(grouped.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

type AstLike = {
  op: string;
  pos: number;
  args: unknown;
  checkedType?: { name?: string };
  meta?: {
    alternate?: AstLike;
  };
};

function isAstLike(value: unknown): value is AstLike {
  return Boolean(
    value &&
      typeof value === "object" &&
      "op" in value &&
      "args" in value &&
      "pos" in value,
  );
}

function walkAst(node: unknown, visit: (node: AstLike) => void) {
  if (!isAstLike(node)) return;
  visit(node);

  if (Array.isArray(node.args)) {
    for (const arg of node.args) {
      if (Array.isArray(arg)) {
        for (const inner of arg) walkAst(inner, visit);
        continue;
      }
      walkAst(arg, visit);
    }
    return;
  }

  if (!node.args || typeof node.args !== "object") return;
  for (const value of Object.values(node.args)) {
    walkAst(value, visit);
  }
}

function isCompletionChar(char: string | undefined) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    char === "." ||
    char === "_" ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function getCompletionToken(state: EditorState, pos: number) {
  const doc = state.doc.toString();
  let from = pos;

  while (from > 0 && isCompletionChar(doc[from - 1])) {
    from -= 1;
  }

  return {
    from,
    to: pos,
    text: doc.slice(from, pos),
  };
}

function appendMissingClosers(expression: string) {
  const expectedClosers: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of expression) {
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      expectedClosers.push(")");
      continue;
    }

    if (char === "[") {
      expectedClosers.push("]");
      continue;
    }

    if (char === "{") {
      expectedClosers.push("}");
      continue;
    }

    const expected = expectedClosers[expectedClosers.length - 1];
    if (expected && char === expected) {
      expectedClosers.pop();
    }
  }

  return expression + expectedClosers.reverse().join("");
}

function createAnalysisExpression(
  source: string,
  token: { from: number; to: number; text: string },
) {
  const endsWithDot = token.text.endsWith(".");
  const parts = token.text.split(".");
  const lastSegment = parts.pop() ?? "";
  const partial = endsWithDot ? "" : lastSegment;
  const memberAccess = parts.length > 0;
  const replacement = memberAccess
    ? `${parts.join(".")}.${autocompleteSentinel}`
    : autocompleteSentinel;
  const expression =
    source.slice(0, token.from) + replacement + source.slice(token.to);

  return {
    partial,
    memberAccess,
    cursor: token.from + replacement.length,
    expression: appendMissingClosers(expression),
  };
}

function getAstEnd(node: AstLike) {
  try {
    return node.pos + serialize(node as never).length;
  } catch {
    return node.pos;
  }
}

function collectScopedBindings(root: AstLike, cursor: number) {
  const bindings: Record<string, string> = {};

  walkAst(root, (node) => {
    const alternate = node.meta?.alternate;
    if (!alternate || alternate.op !== "comprehension") return;

    const args =
      alternate.args && typeof alternate.args === "object"
        ? (alternate.args as {
            iterVarName?: unknown;
            iterCtx?: { iterType?: { name?: string } };
            iterable?: AstLike;
          })
        : null;

    const iterVarName =
      args && typeof args.iterVarName === "string" ? args.iterVarName : null;
    const iterType =
      args?.iterCtx?.iterType?.name ??
      listElementType(args?.iterable?.checkedType?.name ?? "");

    if (!iterVarName || !iterType) return;

    const callArgs = Array.isArray(node.args) ? node.args[2] : null;
    const bodyArgs = Array.isArray(callArgs) ? callArgs : [];
    const bodyStartNode = isAstLike(bodyArgs[1])
      ? bodyArgs[1]
      : isAstLike(bodyArgs[0])
        ? bodyArgs[0]
        : null;
    const bodyStart = bodyStartNode?.pos ?? node.pos;
    const callEnd = getAstEnd(node);

    if (cursor >= bodyStart && cursor <= callEnd) {
      bindings[iterVarName] = iterType;
    }
  });

  return bindings;
}

function findSentinelReceiverType(root: AstLike) {
  let receiverType: string | null = null;

  walkAst(root, (node) => {
    if (receiverType) return;
    if (node.op !== "." && node.op !== ".?") return;
    if (!Array.isArray(node.args)) return;

    const [receiver, property] = node.args;
    if (property !== autocompleteSentinel) return;
    if (!isAstLike(receiver)) return;

    receiverType = receiver.checkedType?.name ?? null;
  });

  return receiverType;
}

function analyzeCompletionContext(
  env: Environment,
  source: string,
  token: { from: number; to: number; text: string },
) {
  const analysis = createAnalysisExpression(source, token);

  try {
    const parsed = env.parse(analysis.expression);
    parsed.check();
    const root = parsed.ast as AstLike;

    return {
      partial: analysis.partial,
      memberAccess: analysis.memberAccess,
      localBindings: collectScopedBindings(root, analysis.cursor),
      receiverType: analysis.memberAccess ? findSentinelReceiverType(root) : null,
    };
  } catch {
    return {
      partial: analysis.partial,
      memberAccess: analysis.memberAccess,
      localBindings: {},
      receiverType: null,
    };
  }
}

function functionDocKey(receiverType: string | null, name: string) {
  return `${receiverType ?? "global"}:${name}`;
}

function getVariableDescription(name: string, fallback: string | null = null) {
  return fallback ?? builtinVariableDescriptions[name] ?? null;
}

function getFieldDescription(typeName: string, fieldName: string) {
  return typeFieldDescriptions[typeName]?.[fieldName] ?? null;
}

function resolveExpressionType(
  expression: string,
  localBindings: Record<string, string>,
  variableDefinitions: Map<string, DefinitionsResult["variables"][number]>,
  functions: DefinitionsResult["functions"],
) {
  const segments = expression.split(".").filter(Boolean);
  if (segments.length === 0) return null;

  let currentType =
    localBindings[segments[0]] ??
    variableDefinitions.get(segments[0])?.type ??
    rootBindingTypes[segments[0]] ??
    null;

  if (!currentType) return null;

  for (const segment of segments.slice(1)) {
    const fieldType = resolveTypeFields(currentType)?.[segment];
    if (fieldType) {
      currentType = fieldType;
      continue;
    }

    const method = functions.find(
      (definition) =>
        definition.receiverType != null &&
        definition.name === segment &&
        receiverMatches(definition.receiverType, currentType),
    );
    if (method) {
      currentType = method.returnType;
      continue;
    }

    return null;
  }

  return currentType;
}

function getFunctionDocumentation(
  definition: DefinitionsResult["functions"][number],
) {
  return functionDocumentation[functionDocKey(definition.receiverType, definition.name)];
}

function getFunctionParams(
  definition: DefinitionsResult["functions"][number],
) {
  return (
    getFunctionDocumentation(definition)?.params ??
    definition.params.map((param) => ({
      name: param.name,
      type: param.type,
      description: param.description ?? "",
    }))
  );
}

function getFunctionDescription(
  definition: DefinitionsResult["functions"][number],
) {
  return (
    definition.description ??
    getFunctionDocumentation(definition)?.description ??
    null
  );
}

function buildFunctionInfoText(overloads: DefinitionsResult["functions"]) {
  const first = overloads[0];
  const description = getFunctionDescription(first);
  const params = getFunctionParams(first)
    .map((param) =>
      param.description
        ? `${param.name}: ${param.type} — ${param.description}`
        : `${param.name}: ${param.type}`,
    )
    .join("\n");
  const examples = getFunctionDocumentation(first)?.examples?.join("\n") ?? "";

  return overloads
    .map((definition) => definition.signature)
    .concat(description ? ["", description] : [])
    .concat(params ? ["", params] : [])
    .concat(examples ? ["", examples] : [])
    .join("\n");
}

function buildVariableInfoText(
  name: string,
  type: string,
  description: string | null = null,
) {
  const resolvedDescription = getVariableDescription(name, description);
  return resolvedDescription ? `${name}: ${type}\n\n${resolvedDescription}` : `${name}: ${type}`;
}

function isIdentifierChar(char: string | undefined) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    char === "_" ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

function getHoverTarget(state: EditorState, pos: number, side: -1 | 1) {
  const doc = state.doc.toString();
  let cursor = pos;

  if (!isIdentifierChar(doc[cursor]) && side < 0 && cursor > 0) {
    cursor -= 1;
  }

  if (!isIdentifierChar(doc[cursor])) return null;

  let from = cursor;
  while (from > 0 && isIdentifierChar(doc[from - 1])) {
    from -= 1;
  }

  let to = cursor + 1;
  while (to < doc.length && isIdentifierChar(doc[to])) {
    to += 1;
  }

  let chainFrom = from;
  while (chainFrom > 1 && doc[chainFrom - 1] === ".") {
    let segmentStart = chainFrom - 1;
    while (segmentStart > 0 && isIdentifierChar(doc[segmentStart - 1])) {
      segmentStart -= 1;
    }
    if (segmentStart === chainFrom - 1) break;
    chainFrom = segmentStart;
  }

  return {
    from,
    to,
    label: doc.slice(from, to),
    chainFrom,
    chainText: doc.slice(chainFrom, to),
  };
}

function createHoverContent({
  title,
  kind,
  typeLabel,
  description,
  signatures = [],
  params = [],
  examples = [],
}: {
  title: string;
  kind: string;
  typeLabel?: string | null;
  description?: string | null;
  signatures?: string[];
  params?: Array<{ name: string; type: string; description?: string }>;
  examples?: string[];
}) {
  const dom = document.createElement("div");
  dom.className = "cm-cel-hover";

  const header = document.createElement("div");
  header.className = "cm-cel-hover-header";

  const titleNode = document.createElement("div");
  titleNode.className = "cm-cel-hover-title";
  titleNode.textContent = title;
  header.appendChild(titleNode);

  const kindNode = document.createElement("div");
  kindNode.className = "cm-cel-hover-kind";
  kindNode.textContent = kind;
  header.appendChild(kindNode);
  dom.appendChild(header);

  if (typeLabel) {
    const typeNode = document.createElement("div");
    typeNode.className = "cm-cel-hover-type";
    typeNode.textContent = typeLabel;
    dom.appendChild(typeNode);
  }

  for (const signature of signatures) {
    const signatureNode = document.createElement("div");
    signatureNode.className = "cm-cel-hover-signature";
    signatureNode.textContent = signature;
    dom.appendChild(signatureNode);
  }

  if (description) {
    const descriptionNode = document.createElement("div");
    descriptionNode.className = "cm-cel-hover-description";
    descriptionNode.textContent = description;
    dom.appendChild(descriptionNode);
  }

  if (params.length > 0) {
    const paramsNode = document.createElement("div");
    paramsNode.className = "cm-cel-hover-section";
    paramsNode.textContent = "Parameters";
    dom.appendChild(paramsNode);

    for (const param of params) {
      const paramNode = document.createElement("div");
      paramNode.className = "cm-cel-hover-param";
      paramNode.textContent = param.description
        ? `${param.name}: ${param.type} — ${param.description}`
        : `${param.name}: ${param.type}`;
      dom.appendChild(paramNode);
    }
  }

  if (examples.length > 0) {
    const examplesNode = document.createElement("div");
    examplesNode.className = "cm-cel-hover-section";
    examplesNode.textContent = "Examples";
    dom.appendChild(examplesNode);

    for (const example of examples) {
      const exampleNode = document.createElement("div");
      exampleNode.className = "cm-cel-hover-example";
      exampleNode.textContent = example;
      dom.appendChild(exampleNode);
    }
  }

  return dom;
}

function createHoverTooltip(
  range: { from: number; to: number },
  content: HTMLElement,
) {
  return {
    pos: range.from,
    end: range.to,
    above: true,
    arrow: true,
    create() {
      return { dom: content };
    },
  };
}

function nextNonWhitespaceChar(source: string, from: number) {
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char && !/\s/.test(char)) return char;
  }
  return null;
}

function stripErrorContext(message: string) {
  const marker = message.indexOf("\n\n>");
  return marker === -1 ? message : message.slice(0, marker);
}

function getDiagnosticRange(error: { node?: unknown }, docLength: number) {
  const node = error.node;
  if (!node || typeof node !== "object" || !("pos" in node)) {
    return { from: 0, to: Math.min(1, docLength) };
  }

  const from = Math.max(
    0,
    Math.min(typeof node.pos === "number" ? node.pos : 0, docLength),
  );

  if (isAstLike(node)) {
    return {
      from,
      to: Math.min(docLength, Math.max(from + 1, getAstEnd(node))),
    };
  }

  return { from, to: Math.min(docLength, from + 1) };
}

function cmTheme() {
  return EditorView.theme(
    {
      "&": {
        fontSize: "14px",
        borderRadius: "1rem",
        border: "1px solid rgba(148, 163, 184, 0.28)",
        overflow: "hidden",
        background:
          "linear-gradient(180deg, rgba(15, 23, 42, 0.98) 0%, rgba(17, 24, 39, 1) 100%)",
        color: "#e5e7eb",
        boxShadow:
          "inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 18px 40px rgba(15, 23, 42, 0.18)",
      },
      ".cm-scroller": {
        minHeight: "280px",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      },
      ".cm-content": {
        padding: "16px 20px",
        caretColor: "#f8fafc",
      },
      ".cm-line": {
        paddingLeft: "0",
      },
      ".cm-gutters": {
        background:
          "linear-gradient(180deg, rgba(15, 23, 42, 0.98) 0%, rgba(18, 27, 45, 0.98) 100%)",
        color: "#64748b",
        borderRight: "1px solid rgba(148, 163, 184, 0.14)",
      },
      ".cm-activeLine": {
        backgroundColor: "rgba(59, 130, 246, 0.08)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "rgba(37, 99, 235, 0.18)",
        color: "#dbeafe",
      },
      ".cm-selectionBackground": {
        backgroundColor: "rgba(96, 165, 250, 0.26) !important",
      },
      ".cm-focused .cm-cursor, .cm-dropCursor": {
        borderLeftColor: "#f8fafc",
        borderLeftWidth: "2px",
      },
      ".cm-cursorLayer .cm-cursor": {
        borderLeftColor: "#f8fafc",
        borderLeftWidth: "2px",
      },
      ".cm-tooltip": {
        borderRadius: "14px",
        border: "1px solid rgba(148, 163, 184, 0.2)",
        overflow: "hidden",
        boxShadow: "0 24px 50px rgba(2, 6, 23, 0.45)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        backgroundColor: "#0f172a",
        color: "#e5e7eb",
        minWidth: "320px",
      },
      ".cm-tooltip.cm-tooltip-hover": {
        backgroundColor: "#0f172a",
        color: "#e5e7eb",
        maxWidth: "380px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        maxHeight: "260px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        color: "#cbd5e1",
        borderTop: "1px solid rgba(148, 163, 184, 0.08)",
        padding: "8px 12px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "#1d4ed8",
        color: "#ffffff",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li .cm-completionDetail": {
        color: "#94a3b8",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail":
        {
          color: "#dbeafe",
        },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li .cm-completionMatchedText":
        {
          color: "#f8fafc",
          textDecoration: "none",
          fontWeight: "700",
        },
      ".cm-completionIcon": {
        color: "#60a5fa",
      },
      ".cm-completionInfo": {
        backgroundColor: "#0b1220",
        color: "#dbeafe",
        borderLeft: "1px solid rgba(148, 163, 184, 0.16)",
        padding: "12px 14px",
      },
      ".cm-cel-hover": {
        display: "grid",
        gap: "8px",
        padding: "12px 14px",
      },
      ".cm-cel-hover-header": {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      },
      ".cm-cel-hover-title": {
        color: "#f8fafc",
        fontWeight: "700",
      },
      ".cm-cel-hover-kind": {
        color: "#93c5fd",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      ".cm-cel-hover-type": {
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: "12px",
      },
      ".cm-cel-hover-signature": {
        color: "#dbeafe",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: "12px",
      },
      ".cm-cel-hover-description": {
        color: "#cbd5e1",
        lineHeight: "1.5",
      },
      ".cm-cel-hover-section": {
        color: "#94a3b8",
        fontSize: "11px",
        fontWeight: "700",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      ".cm-cel-hover-param, .cm-cel-hover-example": {
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: "12px",
        lineHeight: "1.5",
      },
      ".cm-cel-diagnostic": {
        backgroundColor: "rgba(244, 63, 94, 0.12)",
        textDecoration: "underline wavy rgba(251, 113, 133, 0.95)",
      },
    },
    { dark: true },
  );
}

function CodeMirrorEditor({
  value,
  onChange,
  onRun,
  definitions,
  env,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  definitions: DefinitionsResult;
  env: Environment;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  const variableDefinitions = useMemo(
    () => new Map(definitions.variables.map((definition) => [definition.name, definition])),
    [definitions],
  );

  const globalVariableCompletions = useMemo(() => {
    return definitions.variables
      .filter((definition) =>
        Object.prototype.hasOwnProperty.call(rootBindingTypes, definition.name),
      )
      .map(
        (definition): Completion => ({
          label: definition.name,
          type:
            definition.name === definition.name.toUpperCase()
              ? "constant"
              : "variable",
          detail: definition.type,
          info: buildVariableInfoText(
            definition.name,
            definition.type,
            definition.description,
          ),
          boost: definition.name === definition.name.toUpperCase() ? 80 : 90,
          section: completionSections.globals,
        }),
      );
  }, [definitions]);

  const globalFunctionCompletions = useMemo(() => {
    const supportedFunctions = definitions.functions.filter(
      (definition) =>
        definition.receiverType === null &&
        (definition.description != null ||
          builtInGlobalFunctionNames.has(definition.name)),
    );

    return groupFunctions(supportedFunctions).map(({ name, overloads }) => {
      const first = overloads[0];
      return snippetCompletion(buildSnippetTemplate(first), {
        label: name,
        type: "function",
        detail:
          overloads.length === 1
            ? first.signature
            : `${overloads.length} overloads`,
        info: buildFunctionInfoText(overloads),
        boost: first.description ? 70 : 45,
        section: completionSections.functions,
      });
    });
  }, [definitions]);

  const completionSource = useMemo(() => {
    return (context: CompletionContext) => {
      const token = getCompletionToken(context.state, context.pos);
      if (token.from === token.to && !context.explicit) return null;

      const doc = context.state.doc.toString();
      const analysis = analyzeCompletionContext(env, doc, token);
      const localBindings = analysis.localBindings;

      const localVariableCompletions = Object.entries(localBindings).map(
        ([name, type]): Completion => ({
          label: name,
          type: "variable",
          detail: type,
          info: `Comprehension variable bound from ${type}`,
          boost: 100,
          section: completionSections.locals,
        }),
      );

      let from = context.pos - analysis.partial.length;
      let options: Completion[] = [
        ...localVariableCompletions,
        ...globalVariableCompletions,
        ...globalFunctionCompletions,
        ...celKeywords.map(
          (keyword): Completion => ({
            ...keyword,
            section: completionSections.keywords,
          }),
        ),
      ];

      if (analysis.memberAccess) {
        const receiverType = analysis.receiverType;
        if (!receiverType) return null;

        const propertyCompletions = Object.entries(
          resolveTypeFields(receiverType) ?? {},
        ).map(
          ([name, type]): Completion => ({
            label: name,
            type: "property",
            detail: type,
            info: buildVariableInfoText(
              name,
              type,
              getFieldDescription(receiverType, name),
            ),
            boost: 90,
            section: completionSections.properties,
          }),
        );

        const methodCompletions = groupFunctions(
          definitions.functions.filter(
            (definition) =>
              definition.receiverType != null &&
              receiverMatches(definition.receiverType, receiverType),
          ),
        ).map(({ name, overloads }) => {
          const first = overloads[0];
          return snippetCompletion(buildSnippetTemplate(first), {
            label: name,
            type: "method",
            detail:
              overloads.length === 1
                ? `${first.receiverType}.${first.name}()`
                : `${overloads.length} overloads`,
            info: buildFunctionInfoText(overloads),
            boost: first.description ? 70 : 55,
            section: completionSections.methods,
          });
        });

        options = [...propertyCompletions, ...methodCompletions];
      }

      return {
        from,
        options,
        validFor: /^\w*$/,
      };
    };
  }, [definitions, env, globalFunctionCompletions, globalVariableCompletions]);

  const hoverSource = useMemo(() => {
    return hoverTooltip(
      (view, pos, side) => {
        const target = getHoverTarget(view.state, pos, side);
        if (!target) return null;

        const source = view.state.doc.toString();

        if (target.chainFrom < target.from) {
          const analysis = analyzeCompletionContext(env, source, {
            from: target.chainFrom,
            to: target.to,
            text: target.chainText,
          });

          const receiverText = target.chainText.slice(
            0,
            Math.max(0, target.chainText.length - target.label.length - 1),
          );
          const receiverType =
            analysis.receiverType ??
            resolveExpressionType(
              receiverText,
              analysis.localBindings,
              variableDefinitions,
              definitions.functions,
            );
          if (!receiverType) return null;

          const methodOverloads = definitions.functions.filter(
            (definition) =>
              definition.receiverType != null &&
              definition.name === target.label &&
              receiverMatches(definition.receiverType, receiverType),
          );

          if (methodOverloads.length > 0) {
            const first = methodOverloads[0];
            return createHoverTooltip(
              { from: target.from, to: target.to },
              createHoverContent({
                title: target.label,
                kind: "Method",
                typeLabel: `Returns ${first.returnType}`,
                signatures: methodOverloads.map(
                  (definition) => definition.signature,
                ),
                description: getFunctionDescription(first),
                params: getFunctionParams(first),
                examples: getFunctionDocumentation(first)?.examples ?? [],
              }),
            );
          }

          const fieldType = resolveTypeFields(receiverType)?.[target.label];
          if (fieldType) {
            return createHoverTooltip(
              { from: target.from, to: target.to },
              createHoverContent({
                title: target.label,
                kind: "Field",
                typeLabel: `${receiverType} -> ${fieldType}`,
                description:
                  getFieldDescription(receiverType, target.label) ??
                  `Field on ${receiverType}.`,
              }),
            );
          }

          return null;
        }

        const analysis = analyzeCompletionContext(env, source, {
          from: target.from,
          to: target.to,
          text: target.label,
        });

        const localBinding = analysis.localBindings[target.label];
        if (localBinding) {
          return createHoverTooltip(
            { from: target.from, to: target.to },
            createHoverContent({
              title: target.label,
              kind: "Local",
              typeLabel: localBinding,
              description: "Comprehension variable introduced by the surrounding CEL list macro.",
            }),
          );
        }

        if (nextNonWhitespaceChar(source, target.to) === "(") {
          const functionOverloads = definitions.functions.filter(
            (definition) =>
              definition.receiverType === null && definition.name === target.label,
          );

          if (functionOverloads.length > 0) {
            const first = functionOverloads[0];
            return createHoverTooltip(
              { from: target.from, to: target.to },
              createHoverContent({
                title: target.label,
                kind: "Function",
                typeLabel: `Returns ${first.returnType}`,
                signatures: functionOverloads.map(
                  (definition) => definition.signature,
                ),
                description: getFunctionDescription(first),
                params: getFunctionParams(first),
                examples: getFunctionDocumentation(first)?.examples ?? [],
              }),
            );
          }
        }

        const variableDefinition = variableDefinitions.get(target.label);
        if (!variableDefinition) return null;

        return createHoverTooltip(
          { from: target.from, to: target.to },
          createHoverContent({
            title: target.label,
            kind:
              target.label === target.label.toUpperCase() ? "Constant" : "Variable",
            typeLabel: variableDefinition.type,
            description: getVariableDescription(
              variableDefinition.name,
              variableDefinition.description,
            ),
          }),
        );
      },
      {
        hideOnChange: "touch",
        hoverTime: 200,
      },
    );
  }, [definitions, env, variableDefinitions]);

  const celLint = useMemo(() => {
    return linter(
      (view): readonly Diagnostic[] => {
        const source = view.state.doc.toString();
        if (!source.trim()) return [];

        const result = env.check(source);
        if (result.valid || !result.error) return [];

        const { from, to } = getDiagnosticRange(
          result.error as { node?: unknown },
          view.state.doc.length,
        );

        return [
          {
            from,
            to,
            severity: "error",
            source: "cel-js",
            message: stripErrorContext(result.error.message),
            markClass: "cm-cel-diagnostic",
          },
        ];
      },
      { delay: 250 },
    );
  }, [env]);

  useEffect(() => {
    if (!rootRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        cmTheme(),
        celLanguage,
        syntaxHighlighting(celHighlightStyle),
        hoverSource,
        celLint,
        lintGutter(),
        autocompletion({
          override: [completionSource],
          maxRenderedOptions: 12,
        }),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRunRef.current?.();
              return true;
            },
          },
          {
            key: "Ctrl-Space",
            run: startCompletion,
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());

            const cursor = update.state.selection.main.head;
            const justTyped = update.state.sliceDoc(
              Math.max(0, cursor - 1),
              cursor,
            );
            if (justTyped === ".") {
              startCompletion(update.view);
            }
          }
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: rootRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [celLint, completionSource, hoverSource]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;

    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={rootRef} />;
}

function Card({
  title = "",
  subtitle,
  children,
  actions = null,
}: {
  title?: string;
  subtitle: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

export default function CelExpressionEditorDemo() {
  const env = useMemo(() => buildEnvironment(), []);
  const definitions = useMemo(() => env.getDefinitions(), [env]);
  const functionDocs = useMemo(
    () =>
      definitions.functions
        .filter((definition) => definition.description != null)
        .map((definition) => ({
          name: buildFunctionLabel(definition),
          signature: definition.signature,
          description: definition.description ?? "",
        })),
    [definitions],
  );
  const [expression, setExpression] = useState(examples[0].expression);
  const [selectedExample, setSelectedExample] = useState(examples[0].title);
  const [evaluation, setEvaluation] = useState({
    status: "idle",
    checkValid: true,
    inferredType: null as string | null,
    value: null as unknown,
    error: null as string | null,
  });

  const runEvaluation = async (expr: string) => {
    try {
      const checked = env.check(expr);
      const value = await Promise.resolve(env.evaluate(expr, sampleData));
      setEvaluation({
        status: "ok",
        checkValid: checked.valid,
        inferredType: checked.valid ? (checked.type ?? null) : null,
        value,
        error: checked.valid ? null : (checked.error?.message ?? null),
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        setEvaluation({
          status: "error",
          checkValid: false,
          inferredType: null,
          value: null,
          error: "Unknown non-error thrown",
        });
        return;
      }
      let inferredType = null;
      let checkValid = false;
      let checkError = null;

      try {
        const checked = env.check(expr);
        inferredType = checked.valid ? (checked.type ?? null) : null;
        checkValid = checked.valid;
        checkError = checked.valid ? null : (checked.error?.message ?? null);
      } catch {
        // ignore secondary check failure and keep original runtime error
      }

      setEvaluation({
        status: "error",
        checkValid,
        inferredType,
        value: null,
        error: error?.message || checkError || "Unknown error",
      });
    }
  };

  useEffect(() => {
    runEvaluation(expression);
  }, [expression, env]);

  const activeExample = examples.find((item) => item.title === selectedExample);

  return (
    <div className="min-h-screen bg-slate-50 p-6 text-slate-900">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-[28px] border border-slate-200 bg-white px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="mb-2 inline-flex rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                @marcbachmann/cel-js + CodeMirror 6
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">
                Simple CEL expression editor
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-slate-600">
                Live expression editing, type checking, autocomplete, example
                rules, and rendered output. Press{" "}
                <span className="font-semibold">Ctrl/Cmd + Space</span> for
                completions and{" "}
                <span className="font-semibold">Ctrl/Cmd + Enter</span> to
                rerun.
              </p>
            </div>
            <button
              onClick={() => runEvaluation(expression)}
              className="inline-flex items-center justify-center rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
            >
              Evaluate now
            </button>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-6">
            <Card
              title="Editor"
              subtitle="Write a CEL expression against the supplied sample data and custom functions."
              actions={
                <div className="flex flex-wrap gap-2">
                  {examples.map((example) => {
                    const active = example.title === selectedExample;
                    return (
                      <button
                        key={example.title}
                        onClick={() => {
                          setSelectedExample(example.title);
                          setExpression(example.expression);
                        }}
                        className={`rounded-2xl px-3 py-2 text-xs font-medium transition ${
                          active
                            ? "bg-slate-900 text-white"
                            : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                        }`}
                      >
                        {example.title}
                      </button>
                    );
                  })}
                </div>
              }
            >
              <CodeMirrorEditor
                definitions={definitions}
                env={env}
                value={expression}
                onChange={setExpression}
                onRun={() => runEvaluation(expression)}
              />
              {activeExample ? (
                <p className="mt-3 text-sm text-slate-500">
                  Active example: {activeExample.title}
                </p>
              ) : null}
            </Card>

            <Card
              title="Rendered output"
              subtitle="The expression is type-checked and evaluated against the sample context."
            >
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Type check
                  </div>
                  <div
                    className={`mt-2 text-sm font-semibold ${evaluation.checkValid ? "text-emerald-700" : "text-amber-700"}`}
                  >
                    {evaluation.checkValid
                      ? "Valid"
                      : "Check did not fully validate"}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Inferred type
                  </div>
                  <div className="mt-2 break-all text-sm font-semibold text-slate-900">
                    {evaluation.inferredType ?? "—"}
                  </div>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Status
                  </div>
                  <div
                    className={`mt-2 text-sm font-semibold ${evaluation.status === "error" ? "text-rose-700" : "text-emerald-700"}`}
                  >
                    {evaluation.status === "error" ? "Error" : "OK"}
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-950 p-4 text-sm text-slate-100">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Result
                </div>
                <pre className="overflow-auto whitespace-pre-wrap wrap-break-word leading-6">
                  {evaluation.status === "error"
                    ? evaluation.error
                    : formatResult(evaluation.value)}
                </pre>
              </div>
            </Card>
          </div>

          <div className="space-y-6">
            <Card
              title="Sample data"
              subtitle="These objects are available as CEL variables during evaluation."
            >
              <pre className="max-h-105 overflow-auto rounded-2xl bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                {stringify(sampleData)}
              </pre>
            </Card>

            <Card
              title="Functions to try"
              subtitle="A few parameterized functions and one receiver method are registered in the CEL environment."
            >
              <div className="space-y-3">
                {functionDocs.map((fn) => (
                  <div
                    key={fn.name}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="font-mono text-sm font-semibold text-slate-900">
                      {fn.name}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {fn.signature}
                    </div>
                    <div className="mt-2 text-sm text-slate-700">
                      {fn.description}
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            <Card
              title="What to try"
              subtitle="These cover variables, macros, functions, lists, receiver methods, and formatting."
            >
              <ul className="space-y-2 text-sm text-slate-700">
                <li>
                  • <span className="font-mono">customer.name.shout()</span>
                </li>
                <li>
                  •{" "}
                  <span className="font-mono">
                    sum(order.lines.map(l, lineTotal(l)))
                  </span>
                </li>
                <li>
                  •{" "}
                  <span className="font-mono">
                    money(percent(lookupPrice("SKU-3", catalog), 15))
                  </span>
                </li>
                <li>
                  •{" "}
                  <span className="font-mono">
                    order.lines.all(l, l.qty &gt;= 1)
                  </span>
                </li>
                <li>
                  •{" "}
                  <span className="font-mono">has(order.destination.city)</span>
                </li>
                <li>
                  • <span className="font-mono">size(order.notes)</span>
                </li>
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
