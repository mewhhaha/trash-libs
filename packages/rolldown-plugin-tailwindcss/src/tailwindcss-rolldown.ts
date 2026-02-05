import { compile, optimize, toSourceMap } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { exclude, id, include } from "@rolldown/pluginutils";
import type { TopLevelFilterExpression } from "@rolldown/pluginutils";
import path from "node:path";
import process from "node:process";
import type { Plugin, PluginContext, TransformPluginContext } from "rolldown";

const TAILWIND_IMPORT_RE = /@import\s+(?:url\(\s*)?["']tailwindcss["']\s*\)?/;
const hasTailwindDirective = (code: string) => TAILWIND_IMPORT_RE.test(code);

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
  const loadTransformedCssIds = new Set<string>();
  const defaultFilter: TopLevelFilterExpression[] = [
    include(id(/\.css$/i, { cleanUrl: true })),
    exclude(id(/(?:^|[\\/])node_modules(?:[\\/]|$)/)),
    exclude(id(/^\0/)),
  ];
  const userFilter = options.filter;
  const transformFilter: TopLevelFilterExpression[] = userFilter === undefined
    ? defaultFilter
    : [
      ...defaultFilter,
      ...(Array.isArray(userFilter) ? userFilter : [userFilter]),
    ];

  const getAbsoluteCssPath = (id: string): string | null => {
    const [rawPath] = id.split("?", 2);
    if (!rawPath || !rawPath.endsWith(".css")) {
      return null;
    }
    return path.isAbsolute(rawPath) ? rawPath : path.resolve(rootDir, rawPath);
  };

  const transformCss = async (
    ctx: Pick<PluginContext, "addWatchFile">,
    code: string,
    absPath: string,
  ): Promise<{ code: string; map?: string } | null> => {
    const shouldCompileTailwind = hasTailwindDirective(code);
    if (!shouldCompileTailwind && !shouldOptimize) {
      return null;
    }

    let css = code;
    let map: string | undefined;

    if (shouldCompileTailwind) {
      const dependencyPaths = new Set<string>();
      const baseDir = path.dirname(absPath);
      const compiler = await compile(code, {
        from: absPath,
        base: baseDir,
        shouldRewriteUrls: true,
        onDependency: (dependencyPath: string) => {
          const resolvedPath = path.isAbsolute(dependencyPath)
            ? dependencyPath
            : path.resolve(baseDir, dependencyPath);
          dependencyPaths.add(resolvedPath);
        },
      });
      for (const dependencyPath of dependencyPaths) {
        ctx.addWatchFile?.(dependencyPath);
      }

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

    return { code: css, map };
  };

  return {
    name: "tailwindcss:rolldown",
    load: {
      filter: transformFilter,
      async handler(this: PluginContext, id) {
        if (id.startsWith("\0")) {
          return null;
        }
        const absPath = getAbsoluteCssPath(id);
        if (!absPath) {
          return null;
        }
        let code: string;
        try {
          code = await this.fs.readFile(absPath, { encoding: "utf8" });
        } catch {
          return null;
        }
        const result = await transformCss(this, code, absPath);
        if (!result) {
          return null;
        }
        loadTransformedCssIds.add(id);
        return {
          code: result.code,
          map: result.map ?? null,
        };
      },
    },
    buildEnd() {
      loadTransformedCssIds.clear();
    },
    transform: {
      filter: transformFilter,
      async handler(this: TransformPluginContext, code, id) {
        if (id.startsWith("\0")) {
          return null;
        }

        if (loadTransformedCssIds.has(id)) {
          loadTransformedCssIds.delete(id);
          return null;
        }

        const absPath = getAbsoluteCssPath(id);
        if (!absPath) {
          return null;
        }

        const result = await transformCss(this, code, absPath);
        if (!result) {
          return null;
        }

        return {
          code: result.code,
          map: result.map ?? null,
        };
      },
    },
  };
}
