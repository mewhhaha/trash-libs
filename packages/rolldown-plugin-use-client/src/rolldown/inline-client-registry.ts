export const INLINE_ID_PREFIX = "\0inline-client:";

const modules: Map<string, string> = new Map();

export function setInlineClientModule(id: string, code: string): void {
  modules.set(id, code);
}

export function getInlineClientModule(id: string): string | undefined {
  return modules.get(id);
}

export function clearInlineClientModules(): void {
  modules.clear();
}

export function hasInlineClientModule(id: string): boolean {
  return modules.has(id);
}
