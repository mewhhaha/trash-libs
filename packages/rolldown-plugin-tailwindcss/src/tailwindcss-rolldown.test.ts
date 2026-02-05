import { assert, assertExists, assertStringIncludes } from "std/assert";
import path from "node:path";
import tailwindcss from "./tailwindcss-rolldown.ts";

type TransformContextLike = {
  addWatchFile?: (id: string) => void;
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
  plugin: ReturnType<typeof tailwindcss>,
): TransformHandler {
  const transform = plugin.transform;
  if (!transform || typeof transform === "function") {
    throw new Error("Expected transform object with handler");
  }
  const handler = transform.handler;
  if (typeof handler !== "function") {
    throw new Error("Expected transform handler");
  }
  return handler as unknown as TransformHandler;
}

function getResultCode(result: unknown): string | undefined {
  const record = asRecord(result);
  if (!record) return undefined;
  const code = record.code;
  return typeof code === "string" ? code : undefined;
}

Deno.test("tailwind transform tracks dependencies as watch files", async () => {
  const root = await Deno.makeTempDir({ prefix: "tailwind-watch-" });
  const entryPath = path.join(root, "entry.css");
  const depPath = path.join(root, "dep.css");
  const fakeTailwindDir = path.join(root, "node_modules", "tailwindcss");
  await Deno.mkdir(fakeTailwindDir, { recursive: true });
  await Deno.writeTextFile(
    path.join(fakeTailwindDir, "package.json"),
    JSON.stringify(
      {
        name: "tailwindcss",
        version: "0.0.0-test",
        style: "index.css",
      },
      null,
      2,
    ),
  );
  await Deno.writeTextFile(path.join(fakeTailwindDir, "index.css"), ":root {}");
  await Deno.writeTextFile(depPath, ".from-dep { color: red; }");

  const code = `
@import "tailwindcss";
@import "./dep.css";
`;

  const plugin = tailwindcss({ root, optimize: false, minify: false });
  const handler = getTransformHandler(plugin);
  const watched: string[] = [];

  const result = await handler.call(
    {
      addWatchFile(id: string) {
        watched.push(path.resolve(id));
      },
    },
    code,
    entryPath,
  );

  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform should return css output");
  assert(
    watched.includes(path.resolve(depPath)),
    "dependency import should be registered as a watch file",
  );
});

Deno.test("tailwind import detection supports url() form", async () => {
  const root = await Deno.makeTempDir({ prefix: "tailwind-watch-url-" });
  const entryPath = path.join(root, "entry.css");
  const depPath = path.join(root, "dep.css");
  await Deno.writeTextFile(depPath, ".from-dep { color: blue; }");

  const code = `
@import   url('tailwindcss');
@import "./dep.css";
`;

  const plugin = tailwindcss({ root, optimize: false, minify: false });
  const handler = getTransformHandler(plugin);
  const watched: string[] = [];

  const result = await handler.call(
    {
      addWatchFile(id: string) {
        watched.push(path.resolve(id));
      },
    },
    code,
    entryPath,
  );

  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform should run for url() imports");
  assert(
    watched.includes(path.resolve(depPath)),
    "url() tailwind import should still track dependencies",
  );
});

Deno.test("tailwind import compiles into generated utility css", async () => {
  const root = await Deno.makeTempDir({ prefix: "tailwind-transform-" });
  const entryPath = path.join(root, "entry.css");
  const fakeTailwindDir = path.join(root, "node_modules", "tailwindcss");

  await Deno.mkdir(fakeTailwindDir, { recursive: true });
  await Deno.writeTextFile(
    path.join(fakeTailwindDir, "package.json"),
    JSON.stringify(
      {
        name: "tailwindcss",
        version: "0.0.0-test",
        style: "index.css",
      },
      null,
      2,
    ),
  );
  await Deno.writeTextFile(
    path.join(fakeTailwindDir, "index.css"),
    "@theme { --color-red-500: oklch(63.7% 0.237 25.331); } @tailwind utilities;",
  );
  await Deno.writeTextFile(
    path.join(root, "index.html"),
    '<div class="text-red-500"></div>',
  );

  const plugin = tailwindcss({ root, optimize: false, minify: false });
  const handler = getTransformHandler(plugin);
  const result = await handler.call({}, '@import "tailwindcss";', entryPath);

  const resultCode = getResultCode(result);
  assertExists(resultCode, "transform should return css output");
  assertStringIncludes(resultCode, ".text-red-500");
  assertStringIncludes(resultCode, "color: var(--color-red-500);");
  assert(
    !resultCode.includes('@import "tailwindcss"'),
    "tailwind import should be compiled out",
  );
});
