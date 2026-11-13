// Based on get-bb/bb/plugins/account-pool/src/retry-contract.ts (MIT).
// BB Provider Retry asks this contract for the latest failed routed turn.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const retryAvailabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-routed") }),
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("blocked"), retryAt: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum([
      "no-enabled-account",
      "authentication",
      "reset-unknown",
      "source-unavailable",
    ]),
  }),
]);
export type RetryAvailability = z.infer<typeof retryAvailabilitySchema>;
export const retryAvailabilityMethod = "provider-retry.v1.availability";
export const retryAvailabilityContract = defineRpcContract({
  [retryAvailabilityMethod]: {
    input: z.object({
      threadId: z.string().min(1),
      requestId: z.string().min(1),
    }),
    output: retryAvailabilitySchema,
    experimental_description:
      "Availability for a failed request routed through the Balanced pool, honoring account caps, schedule and project policy.",
  },
});
