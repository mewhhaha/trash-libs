import {
  assert,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import path from "node:path";
import { rolldown } from "rolldown";
import useClient from "./inline-client-rolldown.ts";
import {
  getInlineClientModule,
  listInlineClientModules,
} from "./inline-client-registry.ts";

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

    const clientChunk = output.find(
      (chunk: any) =>
        chunk.type === "chunk" &&
        typeof chunk.facadeModuleId === "string" &&
        chunk.facadeModuleId.startsWith("\0inline-client:"),
    ) as any;

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
const events = (fn: any, extra: unknown) => ({ fn, extra });
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
    const clientChunk = output.find(
      (chunk: any) =>
        chunk.type === "chunk" &&
        typeof chunk.facadeModuleId === "string" &&
        chunk.facadeModuleId.startsWith("\0inline-client:"),
    ) as any;

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
  const ctx = {
    emitted,
    warn: () => {},
    addWatchFile: () => {},
    emitFile(chunk: any) {
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

  const handler = typeof plugin.transform === "function"
    ? plugin.transform
    : (plugin.transform as any)?.handler;

  const result: any = await handler.call(ctx as any, code, "/tmp/inline.tsx");

  assertExists(result?.code, "transform result should include code");
  const first = result.code.indexOf("ROLLUP_FILE_URL_ref_0");
  const second = result.code.indexOf("ROLLUP_FILE_URL_ref_1");
  assert(first !== -1 && second !== -1, "both handlers should be replaced");
  const [start, end] = [first, second].sort((a, b) => a - b);
  const between = result.code.slice(start, end);
  assert(
    between.includes(";"),
    "client handler replacements should be separated by a statement boundary",
  );
});

Deno.test("inline handler rejects side-effect imports", async () => {
  const plugin = useClient();
  const handler = typeof plugin.transform === "function"
    ? plugin.transform
    : (plugin.transform as any)?.handler;

  const ctx = {
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
    () => handler.call(ctx as any, code, "/tmp/inline-side-effect.tsx"),
    Error,
    "side-effect imports",
  );
});

Deno.test("inline handler rejects unresolved references", async () => {
  const plugin = useClient();
  const handler = typeof plugin.transform === "function"
    ? plugin.transform
    : (plugin.transform as any)?.handler;

  const ctx = {
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
    () => handler.call(ctx as any, code, "/tmp/inline-unresolved.tsx"),
    Error,
    "references values",
  );
});

Deno.test("inline handler hash follows file contents", async () => {
  const plugin = useClient();
  const handler = typeof plugin.transform === "function"
    ? plugin.transform
    : (plugin.transform as any)?.handler;

  const fileNames: string[] = [];
  const makeCtx = () => ({
    warn: () => {},
    addWatchFile: () => {},
    emitFile(chunk: any) {
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

  await handler.call(makeCtx() as any, code, "/tmp/alpha.tsx");
  await handler.call(makeCtx() as any, code, "/tmp/beta.tsx");

  const hashA = fileNames[0]?.split(".")[1];
  const hashB = fileNames[1]?.split(".")[1];
  assert(hashA && hashB && hashA === hashB, "hash should be content-based");
});
