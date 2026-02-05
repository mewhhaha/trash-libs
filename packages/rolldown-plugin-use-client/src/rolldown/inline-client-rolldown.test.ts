import { assert, assertExists, assertRejects } from "std/assert";
import path from "node:path";
import { rolldown } from "rolldown";
import { parseSync } from "@swc/core";
import useClient from "./inline-client-rolldown.ts";

type EmitFileChunk = { fileName?: string; id?: string };
type TransformContextLike = {
  warn?: (message: string) => void;
  addWatchFile?: (id: string) => void;
  emitFile?: (chunk: EmitFileChunk) => string;
  error?: (message: string) => void;
};
type TransformResult = { code?: string } | null | undefined;
type TransformHandler = (
  this: TransformContextLike,
  code: string,
  id: string,
) => TransformResult | Promise<TransformResult>;
type LoadHandler = (id: string) => unknown | Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function getTransformHandler(
  plugin: ReturnType<typeof useClient>,
): TransformHandler {
  const transform = plugin.transform;
  if (typeof transform === "function") {
    return transform as unknown as TransformHandler;
  }
  const handler = transform && typeof transform === "object"
    ? transform.handler
    : undefined;
  if (typeof handler === "function") {
    return handler as unknown as TransformHandler;
  }
  throw new Error("Expected transform handler");
}

function getLoadHandler(plugin: ReturnType<typeof useClient>): LoadHandler {
  const load = plugin.load;
  if (typeof load === "function") {
    return load as unknown as LoadHandler;
  }
  throw new Error("Expected load handler");
}

function getResultCode(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const code = record.code;
  return typeof code === "string" ? code : undefined;
}

function countRefMarkers(code: string): number {
  return code.match(/ROLLUP_FILE_URL_ref_/g)?.length ?? 0;
}

function isInlineClientChunk(
  value: unknown,
): value is { type: "chunk"; facadeModuleId: string; code: string } {
  const record = asRecord(value);
  if (!record || record.type !== "chunk") return false;
  const facadeModuleId = typeof record.facadeModuleId === "string"
    ? record.facadeModuleId
    : null;
  if (!facadeModuleId || !facadeModuleId.startsWith("\0inline-client:")) {
    return false;
  }
  return typeof record.code === "string";
}

Deno.test("nested inline handler still emits client chunk", async () => {
  const root = await Deno.makeTempDir({ prefix: "use-client-test-" });

  const entry = path.join(root, "entry.ts");
  const shared = path.join(root, "shared.ts");
  const serverOnly = path.join(root, "server-only.ts");

  await Deno.writeTextFile(
    entry,
    `
import { serverOnly } from "./server-only.ts";
import { shared } from "./shared.ts";

export function Component() {
  function wrapper() {
    const handler = () => {
      "use client";
      return shared();
    };
    return handler;
  }

  serverOnly();
  return wrapper();
}
`.trimStart(),
  );

  await Deno.writeTextFile(
    shared,
    `
export function shared() {
  return "shared";
}
`.trimStart(),
  );

  await Deno.writeTextFile(
    serverOnly,
    `
export function serverOnly() {
  throw new Error("server-only code should stay on the server");
}
`.trimStart(),
  );

  const bundle = await rolldown({
    input: entry,
    plugins: [useClient({ debug: true })],
  });

  try {
    const { output } = await bundle.generate({ format: "esm" });
    const clientChunk = (output as Array<unknown>).find(isInlineClientChunk);

    assertExists(clientChunk, "expected an inline client chunk to be emitted");
    assert(
      !clientChunk.code.includes("serverOnly"),
      "client chunk should not pull in server-only imports",
    );
    assert(
      clientChunk.code.includes("shared"),
      "client chunk should retain the shared import referenced by the handler",
    );
  } finally {
    await bundle.close();
  }
});

Deno.test("inline handler passed as call argument keeps following args intact", async () => {
  const root = await Deno.makeTempDir({ prefix: "use-client-call-" });

  const entry = path.join(root, "entry.tsx");

  await Deno.writeTextFile(
    entry,
    `
const events = (fn, extra) => ({ fn, extra });
const TrashIcon = () => <svg><path /></svg>;

export default function Demo() {
  const handler = events(
    () => {
      "use client";
      return <TrashIcon />;
    },
    { foo: "bar" },
  );

  return <button on={handler}>Click</button>;
}
`.trimStart(),
  );

  const bundle = await rolldown({
    input: entry,
    plugins: [useClient({ debug: true })],
  });

  try {
    const { output } = await bundle.generate({ format: "esm" });
    const clientChunk = (output as Array<unknown>).find(isInlineClientChunk);

    assertExists(clientChunk, "expected an inline client chunk to be emitted");
    assert(
      clientChunk.code.includes("TrashIcon"),
      "client chunk should contain the JSX from the handler",
    );
  } finally {
    await bundle.close();
  }
});

Deno.test("sequential inline handlers keep separators intact", async () => {
  const plugin = useClient({ debug: true });
  const emitted: Array<{ ref: string }> = [];
  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile(_chunk: EmitFileChunk) {
      const ref = `ref_${emitted.length}`;
      emitted.push({ ref });
      return ref;
    },
  };

  const code = `
import { event, submit } from "./client.ts";

const signin = event.click(async (_, signal) => {
  "use client";
  await submit("/auth/challenge", { signal });
});

const register = event.submit(
  async (event: SubmitEvent<HTMLFormElement>, signal) => {
    "use client";
    await submit("/auth/register", new FormData(event.currentTarget), {
      signal,
    });
  },
  { preventDefault: true },
);
`;

  const handler = getTransformHandler(plugin);
  const result = await handler.call(ctx, code, "/tmp/inline.tsx");

  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  const first = resultCode.indexOf("ROLLUP_FILE_URL_ref_0");
  const second = resultCode.indexOf("ROLLUP_FILE_URL_ref_1");
  assert(first !== -1 && second !== -1, "both handlers should be replaced");
  const [start, end] = [first, second].sort((a, b) => a - b);
  const between = resultCode.slice(start, end);
  assert(
    between.includes(";"),
    "client handler replacements should be separated by a statement boundary",
  );
});

Deno.test("inline handler rejects side-effect imports", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `
import "./reset.css";

const handler = () => {
  "use client";
  return 1;
};
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/inline-side-effect.tsx");
    },
    Error,
    "side-effect imports",
  );
});

Deno.test("inline handler rejects unresolved references", async () => {
  const plugin = useClient({ unresolved: "error" });
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `
export function Component() {
  const local = "nope";
  const handler = () => {
    "use client";
    return local;
  };
  return handler;
}
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/inline-unresolved.tsx");
    },
    Error,
    "references values",
  );
});

Deno.test("inline handler warns on unresolved references by default", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);
  const warnings: string[] = [];

  const ctx: TransformContextLike = {
    warn(message: string) {
      warnings.push(message);
    },
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
  };

  const code = `
export function Component() {
  const local = "nope";
  const handler = () => {
    "use client";
    return local;
  };
  return handler;
}
`;

  const result = await handler.call(ctx, code, "/tmp/inline-unresolved-warn.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform should still return code");
  assert(
    warnings.some((message) => message.includes("references values")),
    "default policy should warn on unresolved references",
  );
});

Deno.test("strict mode rejects unresolved references without override", async () => {
  const plugin = useClient({ strict: true });
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `
export function Component() {
  const local = "nope";
  const handler = () => {
    "use client";
    return local;
  };
  return handler;
}
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/inline-unresolved-strict.tsx");
    },
    Error,
    "references values",
  );
});

Deno.test("strict mode unresolved override still applies", async () => {
  const plugin = useClient({ strict: true, unresolved: "ignore" });
  const handler = getTransformHandler(plugin);
  const warnings: string[] = [];

  const ctx: TransformContextLike = {
    warn(message: string) {
      warnings.push(message);
    },
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
  };

  const code = `
export function Component() {
  const local = "nope";
  const handler = () => {
    "use client";
    return local;
  };
  return handler;
}
`;

  const result = await handler.call(
    ctx,
    code,
    "/tmp/inline-unresolved-strict-ignore.tsx",
  );
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform should still return code");
  assert(
    warnings.every((message) => !message.includes("references values")),
    "unresolved override should suppress unresolved warnings",
  );
});

Deno.test("strict mode rejects parse failures", async () => {
  const plugin = useClient({ strict: true });
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  await assertRejects(
    async () => {
      await handler.call(
        ctx,
        `const marker = "use client";\nconst = 1;\n`,
        "/tmp/inline-parse-strict.tsx",
      );
    },
    Error,
    "failed to parse",
  );
});

Deno.test("non-strict parse failures warn and skip transform", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);
  const warnings: string[] = [];

  const ctx: TransformContextLike = {
    warn(message: string) {
      warnings.push(message);
    },
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
  };

  const result = await handler.call(
    ctx,
    `const marker = "use client";\nconst = 1;\n`,
    "/tmp/inline-parse-warn.tsx",
  );
  assert(
    getResultCode(result) === undefined,
    "parse failure should skip transform in non-strict mode",
  );
  assert(
    warnings.some((message) => message.includes("failed to parse")),
    "non-strict parse failure should warn",
  );
});

Deno.test("inline handler hash follows file contents", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const fileNames: Array<string | undefined> = [];
  const makeCtx = (): TransformContextLike => ({
    warn: () => {},
    addWatchFile: () => {},
    emitFile(chunk: EmitFileChunk) {
      fileNames.push(chunk.fileName);
      return `ref_${fileNames.length - 1}`;
    },
  });

  const code = `
export const handler = () => {
  "use client";
  return "ok";
};
`;

  await handler.call(makeCtx(), code, "/tmp/stable.tsx");
  await handler.call(makeCtx(), code, "/tmp/stable.tsx");

  const hashA = fileNames[0]?.split(".")[1];
  const hashB = fileNames[1]?.split(".")[1];
  assert(hashA && hashB && hashA === hashB, "hash should be content-based");
});

Deno.test("hash changes when file contents change", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const fileNames: Array<string | undefined> = [];
  const makeCtx = (): TransformContextLike => ({
    emitFile(chunk: EmitFileChunk) {
      fileNames.push(chunk.fileName);
      return `ref_${fileNames.length - 1}`;
    },
  });

  const codeA = `
export const handler = () => {
  "use client";
  return "ok";
};
// comment A
`;
  const codeB = `
export const handler = () => {
  "use client";
  return "ok";
};
// comment B
`;

  await handler.call(makeCtx(), codeA, "/tmp/hash.tsx");
  await handler.call(makeCtx(), codeB, "/tmp/hash.tsx");

  const hashA = fileNames[0]?.split(".")[1];
  const hashB = fileNames[1]?.split(".")[1];
  assert(hashA && hashB && hashA !== hashB, "hash should change on edits");
});

Deno.test("same basename and content still emit unique client chunk filenames", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const fileNames: Array<string | undefined> = [];
  const makeCtx = (): TransformContextLike => ({
    emitFile(chunk: EmitFileChunk) {
      fileNames.push(chunk.fileName);
      return `ref_${fileNames.length - 1}`;
    },
  });

  const code = `
export const handler = () => {
  "use client";
  return 1;
};
`;

  await handler.call(makeCtx(), code, "/tmp/a/index.tsx");
  await handler.call(makeCtx(), code, "/tmp/b/index.tsx");

  const nameA = fileNames[0];
  const nameB = fileNames[1];
  assertExists(nameA);
  assertExists(nameB);
  assert(nameA !== nameB, "filenames should not collide across directories");
});

Deno.test("inline module registry is isolated per plugin instance", async () => {
  const pluginA = useClient();
  const pluginB = useClient();
  const handlerA = getTransformHandler(pluginA);
  const handlerB = getTransformHandler(pluginB);
  const loadHandlerA = getLoadHandler(pluginA);
  const loadHandlerB = getLoadHandler(pluginB);

  let moduleIdA = "";
  let moduleIdB = "";
  const ctxA: TransformContextLike = {
    emitFile(chunk: EmitFileChunk) {
      moduleIdA = chunk.id ?? "";
      return "ref_a";
    },
  };
  const ctxB: TransformContextLike = {
    emitFile(chunk: EmitFileChunk) {
      moduleIdB = chunk.id ?? "";
      return "ref_b";
    },
  };

  await handlerA.call(
    ctxA,
    `
const valueA = "plugin-a";
export const handler = () => {
  "use client";
  return valueA;
};
`,
    "/tmp/plugin-a.tsx",
  );

  await handlerB.call(
    ctxB,
    `
const valueB = "plugin-b";
export const handler = () => {
  "use client";
  return valueB;
};
`,
    "/tmp/plugin-b.tsx",
  );

  assert(moduleIdA.length > 0, "plugin A should emit an inline module id");
  assert(moduleIdB.length > 0, "plugin B should emit an inline module id");

  const loadA = await loadHandlerA(moduleIdA);
  const loadB = await loadHandlerB(moduleIdB);
  const crossLoadA = await loadHandlerA(moduleIdB);
  const crossLoadB = await loadHandlerB(moduleIdA);

  const loadCodeA = getResultCode(loadA);
  const loadCodeB = getResultCode(loadB);
  assertExists(loadCodeA, "plugin A should load its inline module");
  assertExists(loadCodeB, "plugin B should load its inline module");
  assert(
    loadCodeA.includes("plugin-a"),
    "plugin A should return its own registry content",
  );
  assert(
    loadCodeB.includes("plugin-b"),
    "plugin B should return its own registry content",
  );
  assert(getResultCode(crossLoadA) === undefined, "plugin A should not load B");
  assert(getResultCode(crossLoadB) === undefined, "plugin B should not load A");
});

Deno.test("leading trivia before handler keeps spans aligned", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `
const top = () => {
  "use client";
  return 1;
};

export const x = top;
`;

  const result = await handler.call(ctx, code, "/tmp/leading-trivia.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes("new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname"),
    "handler should be replaced",
  );
  parseSync(resultCode, { syntax: "typescript", tsx: true, target: "es2024" });
});

Deno.test("BOM and comment trivia before handler keeps spans aligned", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = "\uFEFF// leading comment\nconst top = () => {\n" +
    '  "use client";\n' +
    "  return 1;\n" +
    "};\n";

  const result = await handler.call(ctx, code, "/tmp/bom-trivia.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes("new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname"),
    "handler should be replaced",
  );
  parseSync(resultCode, { syntax: "typescript", tsx: true, target: "es2024" });
});

Deno.test("non-ascii content before handler keeps spans aligned", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `
const label = "café";
const handler = () => {
  "use client";
  return label;
};
`;

  const result = await handler.call(ctx, code, "/tmp/unicode.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes("ROLLUP_FILE_URL_ref_0"),
    "handler should be replaced",
  );
});

Deno.test("type-only imports do not trigger unresolved references", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `
import type { Foo } from "./types.ts";

export const handler = (value: Foo) => {
  "use client";
  return value;
};
`;

  const result = await handler.call(ctx, code, "/tmp/type-only.ts");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes("ROLLUP_FILE_URL_ref_0"),
    "handler should be replaced",
  );
});

Deno.test("inline handlers in object literals and conditionals are replaced", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);
  const emitted: Array<string> = [];
  const ctx: TransformContextLike = {
    emitFile() {
      const ref = `ref_${emitted.length}`;
      emitted.push(ref);
      return ref;
    },
  };

  const code = `
const condition = true;
const config = {
  onClick: () => {
    "use client";
    return 1;
  },
};
const maybe = condition
  ? () => {
      "use client";
      return 2;
    }
  : null;
const list = [() => {
  "use client";
  return 3;
}];
`;

  const result = await handler.call(ctx, code, "/tmp/multi.ts");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    countRefMarkers(resultCode) === 3,
    "expected three handler replacements",
  );
});

Deno.test("top-level function declaration inline handler is replaced", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `function top() {
  "use client";
  return 1;
}

export function Component() {
  return <button on={top}>go</button>;
}
`;

  const result = await handler.call(ctx, code, "/tmp/top-fn.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes(
      "const top = new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname;",
    ),
    "function declaration should become a url binding",
  );
  assert(
    !resultCode.includes("function top"),
    "function declaration syntax should be removed after replacement",
  );
});

Deno.test("exported function declaration inline handler keeps export", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `export function top() {
  "use client";
  return 1;
}

export const useTop = top;
`;

  const result = await handler.call(ctx, code, "/tmp/top-export-fn.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes(
      "export const top = new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname;",
    ),
    "exported function declaration should keep named export",
  );
  assert(
    !resultCode.includes("export function top"),
    "export function syntax should be replaced",
  );
});

Deno.test("export default function declaration inline handler is replaced", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `export default function top() {
  "use client";
  return 1;
}
`;

  const result = await handler.call(ctx, code, "/tmp/top-default-fn.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes(
      "const top = new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname;",
    ),
    "default export should keep a local binding for named functions",
  );
  assert(
    resultCode.includes("export default top;"),
    "default export function should stay as a default export value",
  );
});

Deno.test("named default function binding remains available as value", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `export default function top() {
  "use client";
  return 1;
}

export const alias = top;
`;

  const result = await handler.call(ctx, code, "/tmp/top-default-alias.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes("const top = new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname;"),
    "named default function should keep local binding after rewrite",
  );
  assert(
    resultCode.includes("export const alias = top;"),
    "named binding should remain usable as a value",
  );
});

Deno.test("callable usage of named default function is rejected", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `export default function top() {
  "use client";
  return 1;
}

top();
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/top-default-call-unsafe.tsx");
    },
    Error,
    "used as a callable value",
  );
});

Deno.test("callable usage of anonymous default function is not transformed", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `export default function () {
  "use client";
  return 1;
}
`;

  const result = await handler.call(ctx, code, "/tmp/top-default-anon.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes(
      "export default new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname",
    ),
    "anonymous default function should still rewrite directly to default value",
  );
});

Deno.test("callable usage of extracted function declaration is rejected", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `function top() {
  "use client";
  return 1;
}

top();
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/top-call-unsafe.tsx");
    },
    Error,
    "used as a callable value",
  );
});

Deno.test("new usage of extracted function declaration is rejected", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `function top() {
  "use client";
  return 1;
}

new top();
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/top-new-unsafe.tsx");
    },
    Error,
    "used as a callable value",
  );
});

Deno.test("tagged template usage of extracted function declaration is rejected", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    warn: () => {},
    addWatchFile: () => {},
    emitFile() {
      return "ref_0";
    },
    error(message: string) {
      throw new Error(message);
    },
  };

  const code = `function top() {
  "use client";
  return 1;
}

top\`x\`;
`;

  await assertRejects(
    async () => {
      await handler.call(ctx, code, "/tmp/top-tag-unsafe.tsx");
    },
    Error,
    "used as a callable value",
  );
});

Deno.test("shadowed callable usage does not block extraction", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);

  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const code = `function top() {
  "use client";
  return 1;
}

function invoke(top) {
  return top();
}

export const value = top;
`;

  const result = await handler.call(ctx, code, "/tmp/top-call-shadowed.tsx");
  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform result should include code");
  assert(
    resultCode.includes(
      "const top = new URL(import.meta.ROLLUP_FILE_URL_ref_0).pathname;",
    ),
    "top-level declaration should still be extracted",
  );
});

Deno.test("non-leading use client directive is ignored", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);
  const emitted: Array<string> = [];
  const ctx: TransformContextLike = {
    emitFile() {
      const ref = `ref_${emitted.length}`;
      emitted.push(ref);
      return ref;
    },
  };

  const code = `
const handler = () => {
  const value = 1;
  "use client";
  return value;
};
`;

  const result = await handler.call(ctx, code, "/tmp/not-leading.ts");
  const resultCode = getResultCode(result);
  assert(resultCode === undefined, "handler should not be replaced");
  assert(emitted.length === 0, "no chunks should be emitted");
});

Deno.test("side-effect imports in other modules do not block handlers", async () => {
  const plugin = useClient();
  const handler = getTransformHandler(plugin);
  const ctx: TransformContextLike = {
    emitFile() {
      return "ref_0";
    },
  };

  const sideEffectCode = `
import "./reset.css";
export const value = 1;
`;
  const handlerCode = `
export const handler = () => {
  "use client";
  return 1;
};
`;

  const sideEffectResult = await handler.call(
    ctx,
    sideEffectCode,
    "/tmp/side-effect.ts",
  );
  assert(
    getResultCode(sideEffectResult) === undefined,
    "side-effect-only module should be ignored",
  );

  const handlerResult = await handler.call(
    ctx,
    handlerCode,
    "/tmp/handler.ts",
  );
  const handlerCodeResult = getResultCode(handlerResult);
  assertExists(handlerCodeResult, "handler module should be transformed");
});
