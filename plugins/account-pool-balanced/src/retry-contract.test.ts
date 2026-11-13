import { describe, expect, it } from "vitest";
import { retryAvailabilityMethod, retryAvailabilitySchema } from "./retry-contract.js";

describe("BB Provider Retry compatibility", () => {
  it("exposes the official availability method name", () => {
    expect(retryAvailabilityMethod).toBe("provider-retry.v1.availability");
  });

  it("accepts ready, blocked and unavailable states", () => {
    expect(retryAvailabilitySchema.parse({ kind: "ready" })).toEqual({ kind: "ready" });
    expect(retryAvailabilitySchema.parse({ kind: "blocked", retryAt: 1_000 }))
      .toEqual({ kind: "blocked", retryAt: 1_000 });
    expect(retryAvailabilitySchema.parse({ kind: "unavailable", reason: "reset-unknown" }))
      .toEqual({ kind: "unavailable", reason: "reset-unknown" });
    expect(retryAvailabilitySchema.parse({ kind: "not-routed" }))
      .toEqual({ kind: "not-routed" });
  });

  it("refuses invalid and missing retry timestamps", () => {
    expect(retryAvailabilitySchema.safeParse({ kind: "blocked" }).success).toBe(false);
    expect(retryAvailabilitySchema.safeParse({ kind: "blocked", retryAt: -1 }).success).toBe(false);
    expect(retryAvailabilitySchema.safeParse({ kind: "blocked", retryAt: 1.5 }).success).toBe(false);
  });
});
