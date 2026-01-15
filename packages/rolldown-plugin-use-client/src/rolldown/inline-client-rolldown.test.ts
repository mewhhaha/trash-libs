import { assert, assertExists, assertRejects } from "std/assert";
import path from "node:path";
import { rolldown } from "rolldown";
import useClient from "./inline-client-rolldown.ts";
import {
  getInlineClientModule,
  listInlineClientModules,
} from "./inline-client-registry.ts";

type EmitFileChunk = { fileName?: string };
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

function getResultCode(result: TransformResult): string | undefined {
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
    const modulesBefore = listInlineClientModules();
    console.log("inline modules", modulesBefore);
    const emptyDefault = modulesBefore.find((m) =>
      /export default\s*;/.test(m.code)
    );
    assert(
      !emptyDefault,
      `found empty export default in inline module: ${
        emptyDefault?.id ?? ""
      }\n${emptyDefault?.code ?? ""}`,
    );

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

    const moduleCode = getInlineClientModule(clientChunk.facadeModuleId);
    assertExists(
      moduleCode,
      "inline module code should be present in registry",
    );
    assert(
      moduleCode.includes("TrashIcon"),
      "registry module should keep JSX content",
    );
  } catch (err) {
    const modules = listInlineClientModules();
    console.error("inline modules at failure", modules);
    throw err;
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

  await handler.call(makeCtx(), code, "/tmp/alpha.tsx");
  await handler.call(makeCtx(), code, "/tmp/beta.tsx");

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
