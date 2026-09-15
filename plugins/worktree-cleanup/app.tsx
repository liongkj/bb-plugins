import { useMemo, useState } from 'react';
import { definePluginApp, type JsonValue, type PluginPendingInteractionProps } from '@get-bb/plugin-sdk/app';

type Candidate = {
  reviewId: string;
  path: string;
  branch: string | null;
  ageDays: number;
  uniquePaths: string[];
  verdict: string;
  confidence: number;
  intent: string;
  rationale: string;
};

function candidatesFrom(payload: JsonValue): Candidate[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Candidate => Boolean(item && typeof item === 'object'
    && typeof (item as Candidate).reviewId === 'string'
    && typeof (item as Candidate).path === 'string'));
}

function ReviewDecisions({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const candidates = useMemo(() => candidatesFrom(interaction.payload), [interaction.payload]);
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'archive_remove'>>(
    () => Object.fromEntries(candidates.map(candidate => [candidate.reviewId, 'keep'])),
  );
  const [busy, setBusy] = useState(false);
  const choose = (id: string, action: 'keep' | 'archive_remove') => setDecisions(current => ({ ...current, [id]: action }));
  const finish = async () => {
    setBusy(true);
    try {
      await submit({ decisions: candidates.map(candidate => ({ reviewId: candidate.reviewId, action: decisions[candidate.reviewId] ?? 'keep' })) });
    } finally { setBusy(false); }
  };

  return <div style={{ display: 'grid', gap: 12, maxHeight: '55vh', overflow: 'auto', padding: 12 }}>
    <div>
      <strong>Protected worktrees need a decision</strong>
      <div style={{ opacity: 0.75, fontSize: 13 }}>Keep is selected by default. Removal first creates a private recovery capsule and rechecks the worktree fingerprint.</div>
    </div>
    {candidates.map(candidate => <fieldset key={candidate.reviewId} style={{ border: '1px solid color-mix(in srgb, currentColor 18%, transparent)', borderRadius: 8, padding: 10 }}>
      <legend style={{ padding: '0 5px', fontWeight: 600 }}>{candidate.branch ?? 'detached worktree'}</legend>
      <div style={{ fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere' }}>{candidate.path}</div>
      <div style={{ marginTop: 6, fontSize: 13 }}><strong>{candidate.verdict}</strong> · {Math.round(candidate.confidence * 100)}% · {candidate.intent}</div>
      <div style={{ opacity: 0.8, fontSize: 13 }}>{candidate.rationale}</div>
      <details style={{ marginTop: 6, fontSize: 12 }}><summary>{candidate.uniquePaths.length} unique path(s)</summary>{candidate.uniquePaths.map(path => <div key={path} style={{ fontFamily: 'monospace' }}>{path}</div>)}</details>
      <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
        <label><input type="radio" name={candidate.reviewId} checked={(decisions[candidate.reviewId] ?? 'keep') === 'keep'} onChange={() => choose(candidate.reviewId, 'keep')} /> Keep</label>
        <label><input type="radio" name={candidate.reviewId} checked={decisions[candidate.reviewId] === 'archive_remove'} onChange={() => choose(candidate.reviewId, 'archive_remove')} /> Recover and remove</label>
      </div>
    </fieldset>)}
    {!candidates.length && <div>No valid review candidates were supplied.</div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
      <button type="button" disabled={busy || !candidates.length} onClick={() => void finish()}>{busy ? 'Saving…' : 'Apply decisions'}</button>
    </div>
  </div>;
}

export default definePluginApp(app => {
  app.slots.pendingInteraction({ id: 'worktree-review', component: ReviewDecisions });
});
