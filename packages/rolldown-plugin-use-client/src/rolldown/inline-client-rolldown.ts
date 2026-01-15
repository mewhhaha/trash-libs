import { exclude, id, include } from "@rolldown/pluginutils";
import type { TopLevelFilterExpression } from "@rolldown/pluginutils";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Plugin, TransformPluginContext } from "rolldown";
import { parseSync, printSync } from "@swc/core";
import {
  clearInlineClientModules,
  getInlineClientModule,
  INLINE_ID_PREFIX,
  parseInlineModulePath,
  setInlineClientModule,
} from "./inline-client-registry.ts";

type SwcSpan = { start?: number; end?: number; ctxt?: number };

type SwcNode = {
  type?: string;
  span?: SwcSpan;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

type SwcProgram = SwcNode & { body?: SwcNode[] };

type Replacement = { start: number; end: number; replacement: string };

type ImportInfo = { node: SwcNode; code: string };
type DeclarationInfo = {
  node: SwcNode;
  code: string;
  declared: Set<string>;
  dependencies: Set<string>;
};

const GLOBALS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "global",
  "console",
  "window",
  "document",
  "Document",
  "DocumentFragment",
  "Element",
  "Node",
  "EventTarget",
  "self",
  "globalThis",
  "navigator",
  "history",
  "location",
  "performance",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "setImmediate",
  "clearImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "structuredClone",
  "atob",
  "btoa",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "SubmitEvent",
  "KeyboardEvent",
  "MessageEvent",
  "StorageEvent",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLDivElement",
  "SVGElement",
  "SVGSVGElement",
  "DOMException",
  "DOMParser",
  "CSSStyleSheet",
  "CSSStyleDeclaration",
  "ShadowRoot",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "File",
  "FileList",
  "FileReader",
  "Blob",
  "TextEncoder",
  "TextDecoder",
  "Intl",
  "crypto",
  "Crypto",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Array",
  "Object",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "Date",
  "Error",
  "Promise",
  "arguments",
]);

function dummySpan() {
  return { start: 0, end: 0, ctxt: 0 };
}

function isSwcNode(value: unknown): value is SwcNode {
  return typeof value === "object" && value !== null;
}

function getNodeType(node: SwcNode): string | undefined {
  return typeof node.type === "string" ? node.type : undefined;
}

function getNodeArray(value: unknown): SwcNode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isSwcNode);
}

function getIdentifierValue(node: SwcNode | null | undefined): string | null {
  if (!node) return null;
  const value = node.value;
  return typeof value === "string" ? value : null;
}

function utf8ByteLength(codePoint: number) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function createByteOffsetLookup(code: string) {
  const byteOffsets: number[] = [0];
  const indices: number[] = [0];
  let byteOffset = 0;

  for (let i = 0; i < code.length; i += 1) {
    const codePoint = code.codePointAt(i);
    if (codePoint === undefined) break;
    byteOffset += utf8ByteLength(codePoint);
    const nextIndex = codePoint > 0xffff ? i + 2 : i + 1;
    byteOffsets.push(byteOffset);
    indices.push(nextIndex);
    i = nextIndex - 1;
  }

  return (target: number) => {
    if (target <= 0) return 0;
    const lastIndex = byteOffsets.length - 1;
    if (target >= byteOffsets[lastIndex]) return indices[lastIndex];
    let lo = 0;
    let hi = lastIndex;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const midOffset = byteOffsets[mid];
      if (midOffset === target) {
        return indices[mid];
      }
      if (midOffset < target) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return indices[Math.max(0, hi)];
  };
}

function maybeContainsUseClient(code: string) {
  return code.includes("use client");
}

function parseModule(code: string): SwcProgram {
  return parseSync(code, {
    syntax: "typescript",
    tsx: true,
    target: "es2024",
  }) as unknown as SwcProgram;
}

function getStart(
  node: SwcNode,
  offset = 0,
  toIndex?: (byteOffset: number) => number,
) {
  if (node?.span?.start !== undefined) {
    const absolute = Math.max(0, node.span.start - 1 - offset);
    return toIndex ? Math.max(0, toIndex(absolute)) : Math.max(0, absolute);
  }
  const raw = node.start ?? 0;
  return Math.max(0, raw - offset);
}

function getEnd(
  node: SwcNode,
  offset = 0,
  toIndex?: (byteOffset: number) => number,
) {
  if (node?.span?.end !== undefined) {
    const absolute = Math.max(0, node.span.end - 1 - offset);
    return toIndex ? Math.max(0, toIndex(absolute)) : Math.max(0, absolute);
  }
  const raw = node.end ?? 0;
  return Math.max(0, raw - offset);
}

function getSpanWithParens(
  node: SwcNode,
  code: string,
  offset = 0,
  toIndex?: (byteOffset: number) => number,
) {
  let start = getStart(node, offset, toIndex);
  const end = getEnd(node, offset, toIndex);
  if (start > 0) {
    const prev = code[start - 1];
    const curr = code[start];
    if (curr === ")" && prev === "(") {
      start -= 1;
    }
  }
  return { start, end };
}

function trimForReplacement(
  span: { start: number; end: number },
  code: string,
) {
  let { start, end } = span;
  while (end > start && /\s/.test(code[end - 1])) {
    end -= 1;
  }
  if (end > start && code[end - 1] === ";") {
    end -= 1;
    while (end > start && /\s/.test(code[end - 1])) end -= 1;
  }
  return { start, end };
}

function collectDeclaredFromPattern(pattern: unknown, target: Set<string>) {
  if (!isSwcNode(pattern)) return;
  const patternType = getNodeType(pattern);
  if (!patternType) return;
  switch (patternType) {
    case "Identifier":
      if (typeof pattern.value === "string") {
        target.add(pattern.value);
      }
      return;
    case "ObjectPattern":
      for (const prop of getNodeArray(pattern.properties)) {
        const propType = getNodeType(prop);
        if (propType === "KeyValuePatternProperty") {
          collectDeclaredFromPattern(prop.value, target);
        } else if (propType === "AssignmentPatternProperty") {
          collectDeclaredFromPattern(prop.key, target);
        } else if (propType === "RestElement") {
          collectDeclaredFromPattern(prop.argument, target);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of getNodeArray(pattern.elements)) {
        const elementType = getNodeType(element);
        if (elementType === "RestElement") {
          collectDeclaredFromPattern(element.argument, target);
        } else {
          collectDeclaredFromPattern(element, target);
        }
      }
      return;
    case "RestElement":
      collectDeclaredFromPattern(pattern.argument, target);
      return;
    case "AssignmentPattern":
      collectDeclaredFromPattern(pattern.left, target);
      return;
    default:
      return;
  }
}

const TS_VALUE_WRAPPERS = new Set([
  "TsAsExpression",
  "TsTypeAssertion",
  "TsNonNullExpression",
  "TsSatisfiesExpression",
  "TsInstantiation",
]);

function isTypeOnlyNode(node: unknown) {
  if (!isSwcNode(node)) return false;
  const nodeType = getNodeType(node);
  if (!nodeType) return false;
  if (!nodeType.startsWith("Ts")) return false;
  if (TS_VALUE_WRAPPERS.has(nodeType)) return false;
  if (
    nodeType === "TsEnumDeclaration" || nodeType === "TsConstEnumDeclaration"
  ) {
    return false;
  }
  return true;
}

function isIdentifierReference(node: SwcNode, parent: SwcNode | null) {
  if (!parent) return true;
  const parentType = getNodeType(parent);
  switch (parentType) {
    case "VariableDeclarator":
      return parent.init === node;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return (
        parent.body === node ||
        parent.returnType === node ||
        parent.typeParameters === node ||
        parent.asserts === node
      );
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.superClass === node;
    case "ClassMethod":
    case "ClassPrivateMethod":
    case "ClassProperty":
    case "ClassPrivateProperty":
      if (parent.key === node && !parent.computed) return false;
      return true;
    case "KeyValueProperty":
      if (parent.key === node && !parent.computed) return false;
      return true;
    case "MemberExpression":
    case "OptionalMemberExpression":
      if (parent.property === node && !parent.computed) return false;
      return true;
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      return false;
    case "ExportSpecifier":
      return parent.local === node;
    default:
      return true;
  }
}

function isDeclared(scopes: Array<Set<string>>, name: string) {
  for (let i = scopes.length - 1; i >= 0; i -= 1) {
    if (scopes[i].has(name)) return true;
  }
  return false;
}

function collectReferences(
  node: unknown,
  scopes: Array<Set<string>>,
  out: Set<string>,
  parent: SwcNode | null,
) {
  if (!isSwcNode(node)) return;
  if (isTypeOnlyNode(node)) return;

  const nodeType = getNodeType(node);
  if (!nodeType) return;

  if (nodeType === "Identifier") {
    const name = typeof node.value === "string" ? node.value : null;
    if (
      name && isIdentifierReference(node, parent) && !isDeclared(scopes, name)
    ) {
      out.add(name);
    }
    return;
  }

  switch (nodeType) {
    case "ImportDeclaration":
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportDeclaration":
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
    case "ExportDefaultDeclaration":
      return;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      const scope = new Set<string>();
      const identifier = isSwcNode(node.identifier) ? node.identifier : null;
      const identifierName = getIdentifierValue(identifier);
      if (identifierName) {
        scope.add(identifierName);
      }
      for (const param of getNodeArray(node.params)) {
        collectDeclaredFromPattern(param, scope);
        if (getNodeType(param) === "AssignmentPattern") {
          collectReferences(param.right, scopes.concat(scope), out, param);
        }
      }
      scopes.push(scope);
      collectReferences(node.body, scopes, out, node);
      scopes.pop();
      return;
    }
    case "BlockStatement": {
      const scope = new Set<string>();
      scopes.push(scope);
      for (const stmt of getNodeArray(node.stmts)) {
        collectReferences(stmt, scopes, out, node);
      }
      scopes.pop();
      return;
    }
    case "Program": {
      const scope = new Set<string>();
      scopes.push(scope);
      for (const stmt of getNodeArray(node.body)) {
        collectReferences(stmt, scopes, out, node);
      }
      scopes.pop();
      return;
    }
    case "VariableDeclaration": {
      const current = scopes[scopes.length - 1];
      for (const decl of getNodeArray(node.declarations)) {
        collectDeclaredFromPattern(decl.id, current);
        collectReferences(decl.init, scopes, out, decl);
      }
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const current = scopes[scopes.length - 1];
      const identifier = isSwcNode(node.identifier) ? node.identifier : null;
      const identifierName = getIdentifierValue(identifier);
      if (identifierName) {
        current.add(identifierName);
      }
      if (node.superClass) {
        collectReferences(node.superClass, scopes, out, node);
      }
      const classBody = isSwcNode(node.body) ? node.body : null;
      for (const element of getNodeArray(classBody?.body)) {
        collectReferences(element, scopes, out, element);
      }
      return;
    }
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassPrivateMethod":
    case "ClassProperty":
    case "ClassPrivateProperty":
    case "ObjectProperty": {
      if (node.key && node.computed === true) {
        collectReferences(node.key, scopes, out, node);
      }
      collectReferences(node.value, scopes, out, node);
      return;
    }
    default:
      break;
  }

  const nodeRecord = node as Record<string, unknown>;
  for (const key of Object.keys(nodeRecord)) {
    if (
      key === "start" || key === "end" || key === "type" || key === "loc" ||
      key === "span" || key === "ctxt"
    ) continue;
    const value = nodeRecord[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (!isSwcNode(child)) continue;
        if (typeof child.type === "string") {
          collectReferences(child, scopes, out, node);
        }
        const expression = isSwcNode(child.expression)
          ? child.expression
          : null;
        if (expression && typeof expression.type === "string") {
          collectReferences(expression, scopes, out, node);
        }
      }
    } else if (isSwcNode(value) && typeof value.type === "string") {
      collectReferences(value, scopes, out, node);
      const expression = isSwcNode(value.expression) ? value.expression : null;
      if (expression && typeof expression.type === "string") {
        collectReferences(expression, scopes, out, node);
      }
    }
  }
}

function buildImportMap(
  ast: SwcProgram,
  code: string,
  offset: number,
  toIndex?: (byteOffset: number) => number,
) {
  const map = new Map<string, ImportInfo>();

  for (const stmt of getNodeArray(ast.body)) {
    if (getNodeType(stmt) !== "ImportDeclaration") continue;
    if (stmt.typeOnly === true) continue;
    const importCode = code.slice(
      getStart(stmt, offset, toIndex),
      getEnd(stmt, offset, toIndex),
    );
    for (const spec of getNodeArray(stmt.specifiers)) {
      const specType = getNodeType(spec);
      const local = isSwcNode(spec.local) ? spec.local : null;
      const localName = getIdentifierValue(local);
      if (!localName) continue;
      if (specType === "ImportSpecifier") {
        if (spec.isTypeOnly === true) continue;
        map.set(localName, { node: stmt, code: importCode });
      } else if (specType === "ImportDefaultSpecifier") {
        map.set(localName, { node: stmt, code: importCode });
      } else if (specType === "ImportNamespaceSpecifier") {
        map.set(localName, { node: stmt, code: importCode });
      }
    }
  }

  return map;
}

function collectTopLevelDeclarationInfo(
  stmt: SwcNode,
  code: string,
  offset: number,
  toIndex?: (byteOffset: number) => number,
): DeclarationInfo | null {
  let target = stmt;
  if (getNodeType(target) === "ExportDeclaration") {
    const decl = isSwcNode(target.declaration) ? target.declaration : null;
    if (decl) {
      target = decl;
    }
  }

  const targetType = getNodeType(target);
  if (
    targetType !== "FunctionDeclaration" &&
    targetType !== "VariableDeclaration" &&
    targetType !== "ClassDeclaration" &&
    targetType !== "TsEnumDeclaration" &&
    targetType !== "TsConstEnumDeclaration"
  ) {
    return null;
  }

  const declared = new Set<string>();
  if (targetType === "FunctionDeclaration") {
    const identifier = isSwcNode(target.identifier) ? target.identifier : null;
    const name = getIdentifierValue(identifier);
    if (name) {
      declared.add(name);
    }
  } else if (targetType === "VariableDeclaration") {
    for (const decl of getNodeArray(target.declarations)) {
      collectDeclaredFromPattern(decl.id, declared);
    }
  } else {
    const identifier = isSwcNode(target.identifier) ? target.identifier : null;
    const id = isSwcNode(target.id) ? target.id : null;
    const name = getIdentifierValue(identifier) ?? getIdentifierValue(id);
    if (name) {
      declared.add(name);
    }
  }

  const deps = new Set<string>();
  collectReferences(target, [declared], deps, null);

  return {
    node: target,
    code: code.slice(
      getStart(target, offset, toIndex),
      getEnd(target, offset, toIndex),
    ),
    declared,
    dependencies: deps,
  };
}

function buildDeclarationMap(
  ast: SwcProgram,
  code: string,
  offset: number,
  toIndex?: (byteOffset: number) => number,
) {
  const map = new Map<string, DeclarationInfo>();
  for (const stmt of getNodeArray(ast.body)) {
    const info = collectTopLevelDeclarationInfo(stmt, code, offset, toIndex);
    if (!info) continue;
    for (const name of info.declared) {
      map.set(name, info);
    }
  }
  return map;
}

function stripUseClientDirective(fnNode: SwcNode) {
  const body = isSwcNode(fnNode.body) ? fnNode.body : null;
  const stmts = getNodeArray(body?.stmts);
  const first = stmts[0];
  if (
    first &&
    getNodeType(first) === "ExpressionStatement" &&
    isSwcNode(first.expression) &&
    getNodeType(first.expression) === "StringLiteral" &&
    first.expression.value === "use client"
  ) {
    const nextBody = body ? { ...body, stmts: stmts.slice(1) } : null;
    return nextBody ? { ...fnNode, body: nextBody } : fnNode;
  }
  return fnNode;
}

function findInlineFunctions(ast: SwcProgram) {
  const matches: Array<{ node: SwcNode }> = [];
  const stack: SwcNode[] = [ast];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    const nodeType = getNodeType(node);
    if (
      nodeType === "ArrowFunctionExpression" ||
      nodeType === "FunctionExpression"
    ) {
      const body = isSwcNode(node.body) ? node.body : null;
      if (body && getNodeType(body) === "BlockStatement") {
        const stmts = getNodeArray(body.stmts);
        const first = stmts[0];
        const expression = first && isSwcNode(first.expression)
          ? first.expression
          : null;
        const hasDirective = first &&
          getNodeType(first) === "ExpressionStatement" &&
          expression &&
          getNodeType(expression) === "StringLiteral" &&
          expression.value === "use client";
        if (hasDirective) {
          matches.push({ node });
        }
      }
    }

    const nodeRecord = node as Record<string, unknown>;
    for (const key of Object.keys(nodeRecord)) {
      if (
        key === "start" || key === "end" || key === "type" || key === "loc" ||
        key === "span" || key === "ctxt"
      ) continue;
      const value = nodeRecord[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (!isSwcNode(child)) continue;
          if (typeof child.type === "string") {
            stack.push(child);
          }
          const expression = isSwcNode(child.expression)
            ? child.expression
            : null;
          if (expression && typeof expression.type === "string") {
            stack.push(expression);
          }
        }
      } else if (isSwcNode(value) && typeof value.type === "string") {
        stack.push(value);
        const expression = isSwcNode(value.expression)
          ? value.expression
          : null;
        if (expression && typeof expression.type === "string") {
          stack.push(expression);
        }
      }
    }
  }

  return matches;
}

function buildTransformFilter(
  defaults: TopLevelFilterExpression[],
  userFilter: TopLevelFilterExpression | TopLevelFilterExpression[] | undefined,
) {
  if (userFilter === undefined) return defaults;
  return [
    ...defaults,
    ...(Array.isArray(userFilter) ? userFilter : [userFilter]),
  ];
}

export type InlineClientPluginOptions = {
  /**
   * Extra filter expression(s) to append to the default transform filter.
   * By default we include common JS/TS sources and ignore `node_modules`.
   */
  filter?: TopLevelFilterExpression | TopLevelFilterExpression[];
  /**
   * Enable debug logging or supply a custom logger.
   */
  debug?: boolean | ((message: string) => void);
};

export default function inlineClientHandlers(
  options: InlineClientPluginOptions = {},
): Plugin {
  const defaultFilter: TopLevelFilterExpression[] = [
    include(id(/\.[cm]?[jt]sx?$/i, { cleanUrl: true })),
    exclude(id(/(?:^|[\\/])node_modules(?:[\\/]|$)/)),
  ];
  const transformFilter = buildTransformFilter(defaultFilter, options.filter);

  return {
    name: "inline-client-handlers-fast",

    buildStart() {
      clearInlineClientModules();
    },

    transform: {
      filter: transformFilter,
      handler(this: TransformPluginContext, code, id) {
        if (id.startsWith("\0")) return;
        if (!maybeContainsUseClient(code)) return;

        const fail = (message: string) => {
          if (typeof this.error === "function") {
            this.error(message);
          }
          throw new Error(message);
        };

        const debugLog = typeof options.debug === "function"
          ? options.debug
          : options.debug
          ? (msg: string) => this.warn?.(`[use-client] ${msg}`)
          : null;

        const absoluteId = path.isAbsolute(id) ? id : path.resolve(id);
        this.addWatchFile?.(absoluteId);

        let ast: SwcProgram;
        try {
          ast = parseModule(code);
        } catch (error) {
          debugLog?.(
            `parse failed for ${absoluteId}: ${(error as Error).message}`,
          );
          return;
        }

        const offset = Math.max(0, (ast.span?.start ?? 1) - 1);
        const byteOffsetToIndex = createByteOffsetLookup(code);

        const inlineFunctions = findInlineFunctions(ast);
        if (inlineFunctions.length === 0) {
          debugLog?.(`no inline handlers found in ${absoluteId}`);
          return;
        }
        debugLog?.(
          `processing ${absoluteId} (len=${code.length}) with ${inlineFunctions.length} inline handlers`,
        );

        const sideEffectImports = getNodeArray(ast.body).filter((stmt) =>
          getNodeType(stmt) === "ImportDeclaration" &&
          getNodeArray(stmt.specifiers).length === 0 &&
          stmt.typeOnly !== true
        );
        if (sideEffectImports.length > 0) {
          const first = sideEffectImports[0];
          const snippet = code
            .slice(
              getStart(first, offset, byteOffsetToIndex),
              getEnd(first, offset, byteOffsetToIndex),
            )
            .trim();
          fail(
            `[use-client] side-effect imports are not allowed in files with inline handlers (${absoluteId}).` +
              (snippet ? ` Offending import: ${snippet}` : ""),
          );
        }

        const importMap = buildImportMap(ast, code, offset, byteOffsetToIndex);
        const declarationMap = buildDeclarationMap(
          ast,
          code,
          offset,
          byteOffsetToIndex,
        );

        const replacements: Replacement[] = [];
        const fileHash = createHash("sha1").update(code).digest("hex").slice(
          0,
          12,
        );

        for (const { node } of inlineFunctions) {
          const cleanedFn = stripUseClientDirective(node);

          const exportModule: SwcNode = {
            type: "Module",
            span: dummySpan(),
            body: [
              {
                type: "ExportDefaultExpression",
                span: dummySpan(),
                expression: cleanedFn,
              },
            ],
            interpreter: null,
            shebang: null,
          };

          const { code: exportedHandlerCode } = printSync(
            exportModule as unknown as Parameters<typeof printSync>[0],
            {
              minify: false,
              isModule: true,
            },
          );

          const bodyNode = isSwcNode(node.body) ? node.body : node;
          debugLog?.(
            `handler span [${getStart(node, offset, byteOffsetToIndex)}, ${
              getEnd(node, offset, byteOffsetToIndex)
            }], body span [${getStart(bodyNode, offset, byteOffsetToIndex)}, ${
              getEnd(bodyNode, offset, byteOffsetToIndex)
            }], exported code: ${
              exportedHandlerCode.slice(0, 60).replace(/\s+/g, " ")
            }...`,
          );
          const rawSpan = getSpanWithParens(
            node,
            code,
            offset,
            byteOffsetToIndex,
          );
          const span = trimForReplacement(rawSpan, code);

          if (
            span.start < 0 ||
            span.end > code.length ||
            span.start >= span.end
          ) {
            debugLog?.(
              `skipping inline handler with out-of-range span [${span.start}, ${span.end}] (code len=${code.length})`,
            );
            continue;
          }

          const freeRefs = new Set<string>();
          const rootScope = new Set<string>();
          collectReferences(node, [rootScope], freeRefs, null);

          const requiredImports = new Map<SwcNode, ImportInfo>();
          const requiredDeclarations = new Map<SwcNode, DeclarationInfo>();

          const pending = [...freeRefs].filter((name) => !GLOBALS.has(name));
          const seen = new Set(pending);

          const unresolved = pending.filter(
            (name) => !importMap.has(name) && !declarationMap.has(name),
          );
          if (unresolved.length > 0) {
            fail(
              `[use-client] inline handler in ${absoluteId} references values that are not available in the client bundle: ${
                unresolved.join(", ")
              }`,
            );
          }

          while (pending.length > 0) {
            const name = pending.pop();
            if (!name) continue;

            const importInfo = importMap.get(name);
            if (importInfo) {
              requiredImports.set(importInfo.node, importInfo);
              continue;
            }

            const declInfo = declarationMap.get(name);
            if (declInfo && !requiredDeclarations.has(declInfo.node)) {
              requiredDeclarations.set(declInfo.node, declInfo);
              for (const dep of declInfo.dependencies) {
                if (!seen.has(dep) && !GLOBALS.has(dep)) {
                  pending.push(dep);
                  seen.add(dep);
                }
              }
            }
          }

          const sortedImports = Array.from(requiredImports.values()).sort(
            (a, b) =>
              getStart(a.node, offset, byteOffsetToIndex) -
              getStart(b.node, offset, byteOffsetToIndex),
          );
          const importCode = sortedImports.length > 0
            ? `${sortedImports.map((info) => info.code.trim()).join("\n")}\n\n`
            : "";

          const sortedDeclarations = Array.from(requiredDeclarations.values())
            .sort(
              (a, b) =>
                getStart(a.node, offset, byteOffsetToIndex) -
                getStart(b.node, offset, byteOffsetToIndex),
            );
          const declarationCode = sortedDeclarations.length > 0
            ? `${
              sortedDeclarations.map((info) => info.code.trim()).join("\n\n")
            }\n\n`
            : "";

          const hash = createHash("sha1")
            .update(fileHash)
            .update(String(getStart(node, offset, byteOffsetToIndex)))
            .digest("hex")
            .slice(0, 12);

          const baseName = path
            .basename(absoluteId)
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "_");

          const fileName = `${baseName}.${hash}.client.tsx`;
          const inlineModulePath = path.join(
            path.dirname(absoluteId),
            fileName,
          );
          const moduleId = `${INLINE_ID_PREFIX}${inlineModulePath}`;

          const moduleCode =
            `"use client";\n\n${importCode}${declarationCode}${exportedHandlerCode}\n`;

          setInlineClientModule(moduleId, moduleCode);

          const emittedChunk:
            & Parameters<TransformPluginContext["emitFile"]>[0]
            & {
              moduleSideEffects: false;
            } = {
              type: "chunk",
              id: moduleId,
              fileName: `assets/${fileName.replace(/\.tsx?$/, ".js")}`,
              moduleSideEffects: false,
            };

          const refId = this.emitFile(emittedChunk);
          debugLog?.(
            `emitted client chunk ${emittedChunk.fileName} for handler at ${absoluteId}`,
          );

          replacements.push({
            start: span.start,
            end: span.end,
            replacement:
              `new URL(import.meta.ROLLUP_FILE_URL_${refId}).pathname`,
          });
        }

        if (replacements.length === 0) {
          return;
        }

        replacements.sort((a, b) => b.start - a.start);

        let transformed = code;
        for (const { start, end, replacement } of replacements) {
          transformed = transformed.slice(0, start) + replacement +
            transformed.slice(end);
        }

        return {
          code: transformed,
          map: null,
        };
      },
    },

    async resolveId(id, importer) {
      if (typeof id === "string" && typeof importer === "string") {
        if (importer.startsWith(INLINE_ID_PREFIX)) {
          const importerPath = parseInlineModulePath(importer);
          const resolved = await this.resolve?.(id, importerPath, {
            skipSelf: true,
          });
          if (resolved !== null && resolved !== undefined) {
            return resolved;
          }
          if (path.isAbsolute(id)) {
            return id;
          }
          if (id.startsWith(".")) {
            return path.resolve(path.dirname(importerPath), id);
          }
        }

        if (id.startsWith(INLINE_ID_PREFIX)) {
          return id;
        }
      }

      if (typeof id === "string" && id.startsWith(INLINE_ID_PREFIX)) {
        return id;
      }

      return null;
    },

    load(id) {
      if (!id.startsWith(INLINE_ID_PREFIX)) return null;
      const code = getInlineClientModule(id);
      if (code === undefined) return null;
      return {
        code,
        map: null,
        moduleType: "tsx",
      };
    },
  };
}
