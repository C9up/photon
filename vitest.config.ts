import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Node and jsdom only. The real-browser layer lives in `tests/browser/**`
		// and runs via `vitest.browser.config.ts` (Playwright/Chromium) — see the
		// `test:browser` script.
		include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// A .svelte file is compiled and run only in the browser layer.
			exclude: ["src/**/*.d.ts", "src/**/*.svelte"],
			reporter: ["text-summary", "json-summary"],
			thresholds: {
				lines: 82,
				statements: 81,
				branches: 75,
				functions: 73,
			},
		},
	},
});
