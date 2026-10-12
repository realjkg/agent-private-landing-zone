// Node 25 and later expose a global localStorage and sessionStorage that are undefined unless
// --localstorage-file is given, and they shadow happy-dom's storage in the render tests. This
// installs a plain in-memory Storage only where the window has no working one, so runs on
// Node 22 keep happy-dom's own storage and every assertion reads the same API either way.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
  getItem(key: string): string | null { return this.items.get(String(key)) ?? null; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  removeItem(key: string): void { this.items.delete(String(key)); }
  setItem(key: string, value: string): void { this.items.set(String(key), String(value)); }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (typeof window === "undefined") break;
  if (typeof window[name]?.clear === "function") continue;
  Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
}
