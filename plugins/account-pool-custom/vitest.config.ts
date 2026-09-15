import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-account-pool",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
