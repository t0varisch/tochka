import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "jsdom",
		testTimeout: 180_000,
	},
});
