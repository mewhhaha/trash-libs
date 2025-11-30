import { exclude, id, include } from "@rolldown/pluginutils";
import type { TopLevelFilterExpression } from "@rolldown/pluginutils";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Plugin, TransformPluginContext } from "rolldown";
import { parseSync, printSync } from "@swc/core";
import {
  INLINE_ID_PREFIX,
  clearInlineClientModules,
  getInlineClientModule,
  parseInlineModulePath,
  setInlineClientModule,
} from "./inline-client-registry.ts";

type Replacement = { start: number; end: number; replacement: string };

type ImportInfo = { node: any; code: string };
type DeclarationInfo = {
  node: any;
  code: string;
  declared: Set<string>;
  dependencies: Set<string>;
};

const GLOBALS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "console",
  "window",
  "document",
  "self",
  "globalThis",
  "navigator",
  "location",
  "performance",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "fetch",
  "Headers",
  "Request",
  "Response",
  "FormData",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Event",
  "MouseEvent",
  "SubmitEvent",
  "KeyboardEvent",
  "HTMLElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLDivElement",
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

function maybeContainsUseClient(code: string) {
  return code.includes("use client");
}

function parseModule(code: string) {
  return parseSync(code, {
    syntax: "typescript",
    tsx: true,
    target: "es2024",
  }) as any;
}

function getStart(node: any, offset = 0) {
  if (node?.span?.start !== undefined) {
    return Math.max(0, node.span.start - 1 - offset);
  }
  return (node?.start ?? 0) - offset;
}

function getEnd(node: any, offset = 0) {
  if (node?.span?.end !== undefined) {
    return Math.max(0, node.span.end - 1 - offset);
  }
  return (node?.end ?? 0) - offset;
}

function getSpanWithParens(node: any, code: string, offset = 0) {
  let start = getStart(node, offset);
  const end = getEnd(node, offset);
  if (start > 0) {
    const prev = code[start - 1];
    const curr = code[start];
    if (curr === ")" && prev === "(") {
      start -= 1;
    }
  }
  return { start, end };
}

function trimForReplacement(span: { start: number; end: number }, code: string) {
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

function collectDeclaredFromPattern(pattern: any, target: Set<string>) {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      target.add(pattern.value);
      return;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        if (prop.type === "KeyValuePatternProperty") {
          collectDeclaredFromPattern(prop.value, target);
        } else if (prop.type === "AssignmentPatternProperty") {
          collectDeclaredFromPattern(prop.key, target);
        } else if (prop.type === "RestElement") {
          collectDeclaredFromPattern(prop.argument, target);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements ?? []) {
        if (!element) continue;
        if (element.type === "RestElement") {
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

function isIdentifierReference(node: any, parent: any) {
  if (!parent) return true;

  switch (parent.type) {
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

function collectReferences(node: any, scopes: Array<Set<string>>, out: Set<string>, parent: any) {
  if (!node) return;

  if (node.type === "Identifier") {
    if (isIdentifierReference(node, parent) && !isDeclared(scopes, node.value)) {
      out.add(node.value);
    }
    return;
  }

  switch (node.type) {
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
      if (node.identifier?.value) {
        scope.add(node.identifier.value);
      }
      for (const param of node.params) {
        collectDeclaredFromPattern(param, scope);
        if (param.type === "AssignmentPattern") {
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
      for (const stmt of node.stmts ?? []) {
        collectReferences(stmt, scopes, out, node);
      }
      scopes.pop();
      return;
    }
    case "Program": {
      const scope = new Set<string>();
      scopes.push(scope);
      for (const stmt of node.body ?? []) {
        collectReferences(stmt, scopes, out, node);
      }
      scopes.pop();
      return;
    }
    case "VariableDeclaration": {
      const current = scopes[scopes.length - 1];
      for (const decl of node.declarations) {
        collectDeclaredFromPattern(decl.id, current);
        collectReferences(decl.init, scopes, out, decl);
      }
      return;
    }
    case "ClassDeclaration":
    case "ClassExpression": {
      const current = scopes[scopes.length - 1];
      if (node.identifier?.value) {
        current.add(node.identifier.value);
      }
      if (node.superClass) {
        collectReferences(node.superClass, scopes, out, node);
      }
      for (const element of node.body?.body ?? []) {
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
      if (node.key && node.computed) {
        collectReferences(node.key, scopes, out, node);
      }
      collectReferences(node.value, scopes, out, node);
      return;
    }
    default:
      break;
  }

  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type" || key === "loc" || key === "span" || key === "ctxt") continue;
    const value: any = (node as any)[key];
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (!child) continue;
        if (typeof child.type === "string") {
          collectReferences(child, scopes, out, node);
        } else if (child.expression && typeof child.expression.type === "string") {
          collectReferences(child.expression, scopes, out, node);
        }
      }
    } else if (value && typeof value.type === "string") {
      collectReferences(value, scopes, out, node);
    } else if (value && value.expression && typeof value.expression.type === "string") {
      collectReferences(value.expression, scopes, out, node);
    }
  }
}

function buildImportMap(ast: any, code: string, offset: number) {
  const map = new Map<string, ImportInfo>();

  for (const stmt of ast.body ?? []) {
    if (stmt.type !== "ImportDeclaration") continue;
    if (stmt.typeOnly) continue;
    const importCode = code.slice(getStart(stmt, offset), getEnd(stmt, offset));
    for (const spec of stmt.specifiers ?? []) {
      if (spec.type === "ImportSpecifier") {
        if (spec.isTypeOnly) continue;
        map.set(spec.local.value, { node: stmt, code: importCode });
      } else if (spec.type === "ImportDefaultSpecifier") {
        map.set(spec.local.value, { node: stmt, code: importCode });
      } else if (spec.type === "ImportNamespaceSpecifier") {
        map.set(spec.local.value, { node: stmt, code: importCode });
      }
    }
  }

  return map;
}

function collectTopLevelDeclarationInfo(
  stmt: any,
  code: string,
  offset: number,
): DeclarationInfo | null {
  if (stmt.type === "ExportDeclaration" && stmt.declaration) {
    stmt = stmt.declaration;
  }

  if (
    stmt.type === "FunctionDeclaration" ||
    stmt.type === "VariableDeclaration" ||
    stmt.type === "ClassDeclaration"
  ) {
    const declared = new Set<string>();
    if (stmt.type === "FunctionDeclaration" && stmt.identifier?.value) {
      declared.add(stmt.identifier.value);
    } else if (stmt.type === "VariableDeclaration") {
      for (const decl of stmt.declarations) {
        collectDeclaredFromPattern(decl.id, declared);
      }
    } else if (stmt.type === "ClassDeclaration" && stmt.identifier?.value) {
      declared.add(stmt.identifier.value);
    }

    const deps = new Set<string>();
    collectReferences(stmt, [declared], deps, null);

    return {
      node: stmt,
      code: code.slice(getStart(stmt, offset), getEnd(stmt, offset)),
      declared,
      dependencies: deps,
    };
  }
  return null;
}

function buildDeclarationMap(ast: any, code: string, offset: number) {
  const map = new Map<string, DeclarationInfo>();
  for (const stmt of ast.body ?? []) {
    const info = collectTopLevelDeclarationInfo(stmt, code, offset);
    if (!info) continue;
    for (const name of info.declared) {
      map.set(name, info);
    }
  }
  return map;
}

function stripUseClientDirective(fnNode: any) {
  const stmts = fnNode.body?.stmts ?? [];
  if (
    stmts.length > 0 &&
    stmts[0].type === "ExpressionStatement" &&
    stmts[0].expression?.type === "StringLiteral" &&
    stmts[0].expression.value === "use client"
  ) {
    const body = { ...fnNode.body, stmts: stmts.slice(1) };
    return { ...fnNode, body };
  }
  return fnNode;
}

function findInlineFunctions(ast: any) {
  const matches: Array<{ node: any }> = [];
  const stack: Array<any> = [ast];

  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;

    if (
      (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
      node.body &&
      node.body.type === "BlockStatement" &&
      node.body.stmts &&
      node.body.stmts.length > 0
    ) {
      const first = node.body.stmts[0];
      const hasDirective =
        first &&
        first.type === "ExpressionStatement" &&
        first.expression?.type === "StringLiteral" &&
        first.expression.value === "use client";
      if (hasDirective) {
        matches.push({ node });
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "start" || key === "end" || key === "type" || key === "loc" || key === "span" || key === "ctxt") continue;
      const value: any = (node as any)[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          if (!child) continue;
          if (typeof child.type === "string") {
            stack.push(child);
          } else if (child.expression && typeof child.expression.type === "string") {
            stack.push(child.expression);
          }
        }
      } else if (value && typeof value.type === "string") {
        stack.push(value);
      } else if (value && value.expression && typeof value.expression.type === "string") {
        stack.push(value.expression);
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
  return [...defaults, ...(Array.isArray(userFilter) ? userFilter : [userFilter])];
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
      async handler(this: TransformPluginContext, code, id) {
        if (id.startsWith("\0")) return;
        if (!maybeContainsUseClient(code)) return;

        const debugLog =
          typeof options.debug === "function"
            ? options.debug
            : options.debug
              ? (msg: string) => this.warn?.(`[use-client] ${msg}`)
              : null;

        const absoluteId = path.isAbsolute(id) ? id : path.resolve(id);
        this.addWatchFile?.(absoluteId);

        let ast: any;
        try {
          ast = parseModule(code);
        } catch (error) {
          debugLog?.(`parse failed for ${absoluteId}: ${(error as Error).message}`);
          return;
        }

        const inlineFunctions = findInlineFunctions(ast);
        if (inlineFunctions.length === 0) {
          debugLog?.(`no inline handlers found in ${absoluteId}`);
          return;
        }
        debugLog?.(
          `processing ${absoluteId} (len=${code.length}) with ${inlineFunctions.length} inline handlers`,
        );

        const offset = Math.max(0, (ast?.span?.start ?? 1) - 1);

        const importMap = buildImportMap(ast, code, offset);
        const declarationMap = buildDeclarationMap(ast, code, offset);

        const replacements: Replacement[] = [];

        for (const { node } of inlineFunctions) {
          const cleanedFn = stripUseClientDirective(node);

          const exportModule: any = {
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

          const { code: exportedHandlerCode } = printSync(exportModule as any, {
            minify: false,
            isModule: true,
          });

          debugLog?.(
            `handler span [${getStart(node, offset)}, ${getEnd(node, offset)}], body span [${
              getStart(node.body, offset)
            }, ${getEnd(node.body, offset)}], exported code: ${
              exportedHandlerCode.slice(0, 60).replace(/\s+/g, " ")
            }...`,
          );
          const rawSpan = getSpanWithParens(node, code, offset);
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

          const requiredImports = new Map<any, ImportInfo>();
          const requiredDeclarations = new Map<any, DeclarationInfo>();

          const pending = [...freeRefs].filter((name) => !GLOBALS.has(name));
          const seen = new Set(pending);

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
            (a, b) => getStart(a.node, offset) - getStart(b.node, offset),
          );
          const importCode =
            sortedImports.length > 0
              ? `${sortedImports.map((info) => info.code.trim()).join("\n")}\n\n`
              : "";

          const sortedDeclarations = Array.from(requiredDeclarations.values()).sort(
            (a, b) => getStart(a.node, offset) - getStart(b.node, offset),
          );
          const declarationCode =
            sortedDeclarations.length > 0
              ? `${sortedDeclarations.map((info) => info.code.trim()).join("\n\n")}\n\n`
              : "";

          const hash = createHash("sha1")
            .update(absoluteId)
            .update(String(getStart(node, offset)))
            .update(exportedHandlerCode)
            .digest("hex")
            .slice(0, 12);

          const baseName = path
            .basename(absoluteId)
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9_-]+/g, "_");

          const fileName = `${baseName}.${hash}.client.tsx`;
          const inlineModulePath = path.join(path.dirname(absoluteId), fileName);
          const moduleId = `${INLINE_ID_PREFIX}${inlineModulePath}`;

          const moduleCode = `"use client";\n\n${importCode}${declarationCode}${exportedHandlerCode}\n`;

          setInlineClientModule(moduleId, moduleCode);

          const emittedChunk: Parameters<TransformPluginContext["emitFile"]>[0] & {
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
            replacement: `new URL(import.meta.ROLLUP_FILE_URL_${refId}).pathname`,
          });
        }

        if (replacements.length === 0) {
          return;
        }

        replacements.sort((a, b) => b.start - a.start);

        let transformed = code;
        for (const { start, end, replacement } of replacements) {
          transformed = transformed.slice(0, start) + replacement + transformed.slice(end);
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
