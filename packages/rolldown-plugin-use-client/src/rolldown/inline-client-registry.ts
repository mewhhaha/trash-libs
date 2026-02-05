export const INLINE_ID_PREFIX = "\0inline-client:";

export type InlineClientRegistry = {
  set(id: string, code: string): void;
  get(id: string): string | undefined;
  clear(): void;
};

export function createInlineClientRegistry(): InlineClientRegistry {
  const modules = new Map<string, string>();
  return {
    set(id: string, code: string) {
      modules.set(id, code);
    },
    get(id: string) {
      return modules.get(id);
    },
    clear() {
      modules.clear();
    },
  };
}

export function parseInlineModulePath(inlineId: string): string {
  const withoutPrefix = inlineId.slice(INLINE_ID_PREFIX.length);
  const [pathname] = withoutPrefix.split("?", 1);
  return pathname;
}
