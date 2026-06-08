/**
 * Type-erased dynamic-import helper.
 *
 * The framework adapters import optional peer-deps (`react`, `react-dom/client`,
 * `vue`, `svelte`) at runtime. Those modules are NOT installed in the workspace
 * by default — they're declared as optional peer-deps so React-only apps don't
 * pay the Vue / Svelte cost. A direct `await import('react')` would fail tsc's
 * module-resolution because the type declarations aren't on disk.
 *
 * This helper accepts a runtime string spec and returns `unknown`; callers cast
 * to a local module-shape interface they own. tsc never resolves the specifier
 * because it's typed as `string`, not a literal.
 *
 * Browser-only — strict no `node:` imports.
 */

export function dynamicImport<T = unknown>(specifier: string): Promise<T> {
	return import(/* @vite-ignore */ specifier) as Promise<T>;
}
