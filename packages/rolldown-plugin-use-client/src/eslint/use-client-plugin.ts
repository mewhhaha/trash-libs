import type { Rule, SourceCode } from "eslint";
import type {
  ArrowFunctionExpression,
  FunctionExpression,
  Identifier,
  Literal,
  Node as EstreeNode,
} from "estree";

const messages = {
  externalReference:
    'Inline client handlers cannot reference "{{name}}" from an outer scope. Move the value inside the handler or read it from the DOM instead.',
  missingDirective:
    'Inline event handlers passed to the `on` attribute must start with a `"use client"` directive so they can be bundled.',
} as const;

type FunctionNode = FunctionExpression | ArrowFunctionExpression;
type FunctionWithParent = FunctionNode & NodeWithParent;

type NodeWithParent = EstreeNode & {
  parent?: NodeWithParent | null;
};

type ReferenceLike = {
  identifier: Identifier | null;
  resolved: {
    scope: ScopeLike;
    defs: unknown[];
  } | null;
  isTypeReference?: boolean;
};

type ScopeLike = {
  type: string;
  upper?: ScopeLike | null;
  childScopes?: ScopeLike[];
  through?: ReferenceLike[];
};

type ScopeManagerLike = {
  acquire(node: EstreeNode, inner?: boolean): ScopeLike | null;
};

function hasUseClientDirective(node: FunctionNode): boolean {
  if (!node.body || node.body.type !== "BlockStatement") {
    return false;
  }

  const [firstStatement] = node.body.body;
  if (!firstStatement || firstStatement.type !== "ExpressionStatement") {
    return false;
  }

  if ("directive" in firstStatement && firstStatement.directive) {
    return firstStatement.directive === "use client";
  }

  const expr = firstStatement.expression as Literal | undefined;
  return expr?.type === "Literal" && expr.value === "use client";
}

function getFunctionScope(
  sourceCode: SourceCode,
  node: FunctionNode,
): ScopeLike | null {
  const manager = sourceCode.scopeManager as ScopeManagerLike | undefined;
  if (!manager) {
    return null;
  }
  return manager.acquire(node) ?? manager.acquire(node, true);
}

function isScopeWithin(
  candidate: ScopeLike | null | undefined,
  target: ScopeLike,
): boolean {
  let current: ScopeLike | null | undefined = candidate;
  while (current) {
    if (current === target) {
      return true;
    }
    current = current.upper ?? null;
  }
  return false;
}

function reportExternalReferences(
  context: Rule.RuleContext,
  sourceCode: SourceCode,
  functionScope: ScopeLike,
): void {
  const seen = new Map<string, Identifier>();
  const stack: ScopeLike[] = [functionScope];

  while (stack.length > 0) {
    const scope = stack.pop();
    if (!scope) continue;

    for (const child of scope.childScopes ?? []) {
      stack.push(child);
    }

    for (const ref of scope.through ?? []) {
      if (ref.isTypeReference === true) {
        continue;
      }

      const identifier = ref.identifier;
      if (!identifier) {
        continue;
      }

      const resolved = ref.resolved;
      if (!resolved) {
        continue;
      }

      const resolvedScope = resolved.scope;

      if (isScopeWithin(resolvedScope, functionScope)) {
        continue;
      }

      if (
        resolvedScope.type === "global" &&
        Array.isArray(resolved.defs) &&
        resolved.defs.length === 0
      ) {
        continue;
      }

      if (resolvedScope.type === "module") {
        continue;
      }

      const name = identifier.name;
      if (seen.has(name)) {
        continue;
      }

      seen.set(name, identifier);
    }
  }

  for (const [name, identifier] of seen) {
    context.report({
      node: identifier,
      messageId: "externalReference",
      data: { name },
    });
  }
}

function isInsideOnAttribute(node: FunctionWithParent): boolean {
  let current: NodeWithParent | null = node;

  while (current) {
    const parent = current.parent;
    if (!parent) {
      break;
    }

    const parentType = (parent as { type: string }).type;

    if (parentType === "JSXAttribute") {
      const attribute = parent as NodeWithParent & {
        name?: { type?: string; name?: string };
      };
      if (
        attribute.name?.type === "JSXIdentifier" &&
        attribute.name?.name === "on"
      ) {
        return true;
      }
      return false;
    }

    if (
      parentType === "FunctionExpression" ||
      parentType === "ArrowFunctionExpression"
    ) {
      return false;
    }

    current = parent;
  }

  return false;
}

const noInvalidInlineClientClosureRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent inline client handlers from capturing values that will disappear when bundled.",
    },
    schema: [],
    messages,
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      "FunctionExpression, ArrowFunctionExpression"(node: FunctionNode) {
        if (!hasUseClientDirective(node)) {
          return;
        }

        const functionScope = getFunctionScope(sourceCode, node);
        if (!functionScope) {
          return;
        }

        reportExternalReferences(context, sourceCode, functionScope);
      },
    };
  },
};

const requireUseClientDirectiveRule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Require inline handlers passed to the `on` attribute to start with a `"use client"` directive.',
    },
    schema: [],
    fixable: "code",
    messages,
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      "FunctionExpression, ArrowFunctionExpression"(node: FunctionNode) {
        if (!isInsideOnAttribute(node as FunctionWithParent)) {
          return;
        }

        if (hasUseClientDirective(node)) {
          return;
        }

        const block =
          node.body && node.body.type === "BlockStatement" ? node.body : null;

        const fix =
          block !== null
            ? (fixer: Rule.RuleFixer) => {
                const openingBrace = sourceCode.getFirstToken(block);
                if (!openingBrace) {
                  return null;
                }

                const firstStatement = block.body[0] ?? null;
                const fallbackIndent = (block.loc?.start.column ?? 0) + 2;
                const indentSize =
                  firstStatement?.loc?.start.column ?? fallbackIndent;
                const indent = " ".repeat(indentSize);
                const needsTrailingNewline = block.body.length === 0;
                const text =
                  `\n${indent}"use client";` +
                  (needsTrailingNewline ? "\n" : "");

                return fixer.insertTextAfter(openingBrace, text);
              }
            : null;

        context.report({
          node,
          messageId: "missingDirective",
          ...(fix ? { fix } : {}),
        });
      },
    };
  },
};

type UseClientPlugin = {
  rules: Record<string, Rule.RuleModule>;
  configs?: Record<string, unknown>;
};

const plugin: UseClientPlugin = {
  rules: {
    "no-invalid-inline-client-closure": noInvalidInlineClientClosureRule,
    "require-use-client-directive": requireUseClientDirectiveRule,
  },
};

const recommendedConfig = {
  plugins: {
    "@mewhhaha/use-client": plugin,
  },
  rules: {
    "@mewhhaha/use-client/no-invalid-inline-client-closure": "error",
    "@mewhhaha/use-client/require-use-client-directive": "warn",
  },
} satisfies Record<string, unknown>;

plugin.configs = {
  recommended: recommendedConfig,
};

export default plugin;
