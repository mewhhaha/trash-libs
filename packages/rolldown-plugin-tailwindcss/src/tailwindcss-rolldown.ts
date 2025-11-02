import { compile, optimize, toSourceMap } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { exclude, id, include } from "@rolldown/pluginutils";
import type { TopLevelFilterExpression } from "@rolldown/pluginutils";
import path from "node:path";
import type { Plugin, TransformPluginContext } from "rolldown";

const hasTailwindDirective = (code: string) =>
  code.includes('@import "tailwindcss"') ||
  code.includes("@import 'tailwindcss'");

export type TailwindPluginOptions = {
  root?: string;
  minify?: boolean;
  optimize?: boolean;
  /**
   * Extra filter expression(s) appended to the default CSS filter.
   */
  filter?: TopLevelFilterExpression | TopLevelFilterExpression[];
};

export default function tailwindcss(
  options: TailwindPluginOptions = {},
): Plugin {
  const rootDir = options.root ?? process.cwd();
  const shouldOptimize = options.optimize ?? true;
  const shouldMinify = options.minify ?? true;
  const defaultFilter: TopLevelFilterExpression[] = [
    include(id(/\.css$/i, { cleanUrl: true })),
    exclude(id(/(?:^|[\\/])node_modules(?:[\\/]|$)/)),
    exclude(id(/^\0/)),
  ];
  const userFilter = options.filter;
  const transformFilter: TopLevelFilterExpression[] =
    userFilter === undefined
      ? defaultFilter
      : [
          ...defaultFilter,
          ...(Array.isArray(userFilter) ? userFilter : [userFilter]),
        ];

  return {
    name: "tailwindcss:rolldown",
    transform: {
      filter: transformFilter,
      async handler(this: TransformPluginContext, code, id) {
        if (id.startsWith("\0")) {
          return null;
        }

        const [rawPath] = id.split("?", 2);
        if (!rawPath || !rawPath.endsWith(".css")) {
          return null;
        }

        const absPath = path.isAbsolute(rawPath)
          ? rawPath
          : path.resolve(rootDir, rawPath);

        let css = code;
        let map: string | undefined;

        if (hasTailwindDirective(code)) {
          const compiler = await compile(code, {
            from: absPath,
            base: path.dirname(absPath),
            shouldRewriteUrls: true,
            onDependency: () => {
              /* no-op */
            },
          });

          const sources: Array<{
            base: string;
            pattern: string;
            negated: boolean;
          }> = [];
          if (compiler.root === null) {
            sources.push({ base: rootDir, pattern: "**/*", negated: false });
          } else if (compiler.root !== "none") {
            sources.push({ ...compiler.root, negated: false });
          }
          sources.push(...compiler.sources);

          const scanner = new Scanner({ sources });
          const candidates = Array.from(scanner.scan());

          css = compiler.build(candidates);
          const rawMap = compiler.buildSourceMap();
          map = rawMap ? toSourceMap(rawMap).raw : undefined;
        }

        if (shouldOptimize) {
          const optimizeOptions: Parameters<typeof optimize>[1] = {
            minify: shouldMinify,
            file: absPath,
          };
          if (map !== undefined) {
            optimizeOptions.map = map;
          }
          const optimized = optimize(css, optimizeOptions);
          css = optimized.code;
          map = optimized.map;
        }

        return {
          code: css,
          map: map ?? null,
        };
      },
    },
  };
}
