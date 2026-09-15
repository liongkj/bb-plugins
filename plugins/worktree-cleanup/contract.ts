import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const change = z.object({
  path: z.string(),
  kind: z.enum(['tracked', 'untracked']),
  classification: z.enum(['duplicate', 'residue', 'unique']),
  evidence: z.string(),
}).strict();

export const worktreeSchema = z.object({
  sourcePath: z.string(),
  repositoryPath: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string().nullable(),
  primary: z.boolean(),
  protected: z.boolean(),
  ageDays: z.number(),
  fingerprint: z.string(),
  changes: z.array(change).max(200),
  changesTruncated: z.boolean(),
  safeToRemove: z.boolean(),
  reason: z.string(),
  action: z.enum(['kept', 'removed', 'failed']),
}).strict();
export type WorktreeReport = z.infer<typeof worktreeSchema>;

export const hostContract = defineRpcContract({
  scanSources: {
    input: z.object({
      sourcePaths: z.array(z.string().min(1)).max(250),
      protectedPaths: z.array(z.string().min(1)).max(2000),
      retentionDays: z.number().int().min(1).max(3650),
      apply: z.boolean(),
      prune: z.boolean(),
    }).strict(),
    output: z.object({
      repositoriesScanned: z.number().int().nonnegative(),
      metadataPruned: z.boolean(),
      worktrees: z.array(worktreeSchema).max(1000),
      worktreesTruncated: z.boolean(),
      errors: z.array(z.string()).max(100),
      errorsTruncated: z.boolean(),
    }).strict(),
  },
  molePurge: {
    input: z.object({
      sourcePaths: z.array(z.string().min(1)).max(250),
      apply: z.boolean(),
    }).strict(),
    output: z.object({
      available: z.boolean(),
      exitCode: z.number().int(),
      output: z.string().max(100_000),
    }).strict(),
  },
  prepareReview: {
    input: z.object({
      sourcePaths: z.array(z.string().min(1)).max(250),
      protectedPaths: z.array(z.string().min(1)).max(2000),
      retentionDays: z.number().int().min(1).max(3650),
      worktreePath: z.string().min(1),
    }).strict(),
    output: z.object({
      candidate: worktreeSchema.nullable(),
      evidence: z.string().max(60_000),
      redactedPaths: z.array(z.string()).max(200),
    }).strict(),
  },
  applyReviewed: {
    input: z.object({
      sourcePaths: z.array(z.string().min(1)).max(250),
      protectedPaths: z.array(z.string().min(1)).max(2000),
      retentionDays: z.number().int().min(1).max(3650),
      decisions: z.array(z.object({
        worktreePath: z.string().min(1),
        fingerprint: z.string().min(1),
      }).strict()).max(50),
    }).strict(),
    output: z.object({
      results: z.array(z.object({
        worktreePath: z.string(),
        action: z.enum(['removed', 'kept', 'failed']),
        reason: z.string(),
        recoveryPath: z.string().nullable(),
      }).strict()).max(50),
    }).strict(),
  },
});
