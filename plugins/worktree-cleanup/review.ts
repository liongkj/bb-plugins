import { createHash } from 'node:crypto';
import { z } from 'zod';

export const reviewerVerdict = z.object({
  verdict: z.enum(['residue', 'implemented_elsewhere', 'valuable_unique_work', 'uncertain']),
  confidence: z.number().min(0).max(1),
  intent: z.string().max(500),
  rationale: z.string().max(1000),
  evidence: z.array(z.string().max(500)).max(10),
}).strict();

export type ReviewerVerdict = z.infer<typeof reviewerVerdict>;

export const humanResponse = z.object({
  decisions: z.array(z.object({
    reviewId: z.string(),
    action: z.enum(['keep', 'archive_remove']),
  }).strict()).max(50),
}).strict();

export function reviewId(hostId: string, path: string, fingerprint: string): string {
  return createHash('sha256').update(`${hostId}\0${path}\0${fingerprint}`).digest('hex').slice(0, 24);
}

export function parseReviewerOutput(output: string | null): ReviewerVerdict {
  if (!output) throw new Error('Reviewer returned no output');
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  const candidate = fenced ?? output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1);
  return reviewerVerdict.parse(JSON.parse(candidate));
}
