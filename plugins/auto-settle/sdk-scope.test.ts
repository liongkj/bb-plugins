import { describe, expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

describe("public SDK scope", () => {
  it("imports only public packages and package-local files", () => {
    const scan = experimental_scanPublicSdkOnly(import.meta.dirname);
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
