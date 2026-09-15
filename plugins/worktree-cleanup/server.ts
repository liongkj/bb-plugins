import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { inspect } from './cleanup.js';
import { hostContract, type WorktreeReport } from './contract.js';
import { humanResponse, parseReviewerOutput, reviewId, type ReviewerVerdict } from './review.js';

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: {} });
  const settings = bb.settings.define({
    automatic: { type: 'boolean', label: 'Enable automatic cleanup requests', default: false },
    automaticReview: { type: 'boolean', label: 'Ask for review when old unique worktrees are found', default: true },
    retentionDays: { type: 'number', label: 'Minimum days since last environment or archived-thread update', default: 7 },
    projectIds: { type: 'string', label: 'Project IDs (comma separated; empty includes all projects)', default: '' },
  });
  const controller = new AbortController();
  let running: Promise<unknown> | null = null;
  let sourceRunning = false;
  bb.onDispose(async () => { controller.abort(); await running?.catch(() => {}); });

  async function sweep(apply: boolean, callerSignal?: AbortSignal) {
    if (running) throw new Error('A cleanup scan is already running');
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const task = async () => {
      const config = await settings.get();
      if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) throw new Error('retentionDays must be an integer from 1 to 3650');
      const projects = new Set(config.projectIds.split(',').map(s => s.trim()).filter(Boolean));
      // Snapshot IDs before requesting removals so pagination cannot skip rows.
      const ids: string[] = [];
      for (let offset = 0; ; offset += 100) {
        signal.throwIfAborted();
        const page = await bb.sdk.environments.list({ environmentProviderId: 'git-worktree', limit: 100, offset, signal });
        if (offset >= 10000 && page.length) throw new Error('More than 10,000 environments; scan refused');
        ids.push(...page.filter(e => e.status !== 'destroyed' && (!projects.size || projects.has(e.projectId))).map(e => e.id));
        if (page.length < 100) break;
      }
      const report = { mode: apply ? 'apply' : 'preview', scanned: ids.length, eligible: 0, requested: 0, skipped: 0, errors: 0, details: [] as { id: string; result: string }[], detailsTruncated: false };
      for (const id of ids) {
        signal.throwIfAborted();
        let result: string;
        try {
          let inspection = await inspect(bb.sdk, id, config.retentionDays, Date.now(), signal);
          if (!inspection.reason && apply) inspection = await inspect(bb.sdk, id, config.retentionDays, Date.now(), signal);
          if (inspection.reason) { report.skipped++; result = inspection.reason; }
          else {
            report.eligible++;
            if (apply) {
              signal.throwIfAborted();
              if (inspection.unarchivedThreadCount) {
                await bb.sdk.environments.archiveThreads({ environmentId: id });
              }
              await bb.sdk.environments.delete({ environmentId: id });
              report.requested++;
              result = `Cleanup requested after archiving ${inspection.unarchivedThreadCount} thread(s); provider completion is asynchronous`;
              bb.log.info(`Cleanup requested for ${id}`);
            } else result = 'Eligible';
          }
        } catch (error) {
          signal.throwIfAborted();
          report.errors++;
          result = `Failed: ${String(error).slice(0, 300)}`;
        }
        if (report.details.length < 100) report.details.push({ id, result });
        else report.detailsTruncated = true;
      }
      await bb.storage.kv.set('lastReport', { at: new Date().toISOString(), ...report });
      return report;
    };
    running = task();
    try { return await running; } finally { running = null; }
  }

  async function sourceInputs(signal: AbortSignal) {
    const config = await settings.get();
    const allowedProjects = new Set(config.projectIds.split(',').map(value => value.trim()).filter(Boolean));
    const projects = await bb.sdk.projects.list({ signal });
    const byHost = new Map<string, Set<string>>();
    for (const project of projects) {
      if (allowedProjects.size && !allowedProjects.has(project.id)) continue;
      for (const source of project.sources) {
        const paths = byHost.get(source.hostId) ?? new Set<string>();
        paths.add(source.path);
        byHost.set(source.hostId, paths);
      }
    }
    const protectedByHost = new Map<string, Set<string>>();
    for (let offset = 0; ; offset += 100) {
      const environments = await bb.sdk.environments.list({ limit: 100, offset, signal });
      for (const environment of environments) {
        if (environment.status === 'destroyed' || !environment.path) continue;
        const paths = protectedByHost.get(environment.hostId) ?? new Set<string>();
        paths.add(environment.path);
        protectedByHost.set(environment.hostId, paths);
      }
      if (environments.length < 100) break;
      if (offset >= 9900) throw new Error('More than 10,000 environments; source scan refused');
    }
    return { config, byHost, protectedByHost };
  }

  async function sourceSweep(apply: boolean, prune: boolean, callerSignal?: AbortSignal) {
    if (sourceRunning) throw new Error('A source worktree scan is already running');
    sourceRunning = true;
    try {
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const { config, byHost, protectedByHost } = await sourceInputs(signal);
    const report = {
      mode: apply ? 'apply' : 'preview', hosts: byHost.size, repositoriesScanned: 0,
      worktreesScanned: 0, eligible: 0, removed: 0, protected: 0, uniqueChanges: 0,
      metadataPruned: false, errors: [] as string[], details: [] as WorktreeReport[], detailsTruncated: false,
    };
    for (const [hostId, sourcePaths] of byHost) {
      const result = await host.call('scanSources', {
        sourcePaths: [...sourcePaths],
        protectedPaths: [...(protectedByHost.get(hostId) ?? [])],
        retentionDays: config.retentionDays,
        apply,
        prune,
      }, { hostId, signal, timeoutMs: 30 * 60_000 });
      report.repositoriesScanned += result.repositoriesScanned;
      report.metadataPruned ||= result.metadataPruned;
      report.errors.push(...result.errors.map(error => `${hostId}: ${error}`));
      for (const worktree of result.worktrees) {
        if (worktree.primary) continue;
        report.worktreesScanned++;
        if (worktree.safeToRemove) report.eligible++;
        if (worktree.action === 'removed') report.removed++;
        if (worktree.protected) report.protected++;
        if (worktree.changes.some(change => change.classification === 'unique')) report.uniqueChanges++;
        if (report.details.length < 200) report.details.push(worktree);
        else report.detailsTruncated = true;
      }
      report.detailsTruncated ||= result.worktreesTruncated || result.errorsTruncated;
    }
    report.errors = report.errors.slice(0, 100);
    await bb.storage.kv.set('lastSourceReport', { at: new Date().toISOString(), ...report });
    return report;
    } finally {
      sourceRunning = false;
    }
  }

  async function molePreview(callerSignal?: AbortSignal) {
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const { byHost } = await sourceInputs(signal);
    const reports = [];
    for (const [hostId, sourcePaths] of byHost) {
      reports.push({ hostId, ...(await host.call('molePurge', { sourcePaths: [...sourcePaths], apply: false }, { hostId, signal, timeoutMs: 30 * 60_000 })) });
    }
    return reports;
  }

  async function agentReview(projectId: string, threadId: string, evidence: string, redactedPaths: string[], reviewKey: string, signal: AbortSignal): Promise<ReviewerVerdict> {
    if (redactedPaths.length && !evidence.includes('Working tree patch:') && !evidence.includes('Untracked preview')) {
      return { verdict: 'uncertain', confidence: 1, intent: 'Sensitive or binary-only changes', rationale: 'File contents were withheld from automated review.', evidence: redactedPaths.slice(0, 10) };
    }
    const current = await bb.sdk.threads.get({ threadId });
    const worker = await bb.sdk.threads.spawn({
      projectId,
      environment: current.environmentId ? { type: 'reuse', environmentId: current.environmentId } : { type: 'project-default' },
      visibility: 'hidden',
      title: `Worktree cleanup review ${reviewKey}`,
      pluginMetadata: { kind: 'semantic-review', reviewId: reviewKey },
      prompt: [
        'Review the supplied Git worktree evidence. Decide whether the unique files are generated residue, behavior already implemented elsewhere according to explicit evidence, valuable unique work, or uncertain.',
        'Do not claim implementation elsewhere unless the supplied evidence identifies it. Treat secrets, migrations, deployment configuration, and ambiguous changes conservatively.',
        'Return only JSON with exactly: verdict (residue|implemented_elsewhere|valuable_unique_work|uncertain), confidence (0..1), intent (string), rationale (string), evidence (string array).',
        '', evidence,
      ].join('\n'),
    });
    try {
      await bb.sdk.threads.wait({ threadId: worker.id, status: 'idle', timeoutMs: 10 * 60_000, signal });
      return parseReviewerOutput((await bb.sdk.threads.output({ threadId: worker.id })).output);
    } finally {
      await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
      await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
    }
  }

  async function interactiveReview(threadId: string, projectId: string, signal: AbortSignal) {
    const { config, byHost, protectedByHost } = await sourceInputs(signal);
    const candidates: Array<{
      hostId: string; sourcePaths: string[]; protectedPaths: string[];
      worktree: WorktreeReport;
      reviewId: string; review: ReviewerVerdict;
    }> = [];
    for (const [hostId, sourcePathsSet] of byHost) {
      const sourcePaths = [...sourcePathsSet];
      const protectedPaths = [...(protectedByHost.get(hostId) ?? [])];
      const scan = await host.call('scanSources', { sourcePaths, protectedPaths, retentionDays: config.retentionDays, apply: false, prune: false }, { hostId, signal, timeoutMs: 30 * 60_000 });
      for (const worktree of scan.worktrees) {
        if (worktree.primary || worktree.protected || worktree.ageDays < config.retentionDays || worktree.changesTruncated || !worktree.changes.some(change => change.classification === 'unique')) continue;
        const prepared = await host.call('prepareReview', { sourcePaths, protectedPaths, retentionDays: config.retentionDays, worktreePath: worktree.path }, { hostId, signal, timeoutMs: 5 * 60_000 });
        if (!prepared.candidate || prepared.candidate.fingerprint !== worktree.fingerprint) continue;
        const key = reviewId(hostId, worktree.path, worktree.fingerprint);
        let review: ReviewerVerdict;
        try { review = await agentReview(projectId, threadId, prepared.evidence, prepared.redactedPaths, key, signal); }
        catch (error) { review = { verdict: 'uncertain', confidence: 0, intent: 'Automated review failed', rationale: String(error).slice(0, 800), evidence: [] }; }
        candidates.push({ hostId, sourcePaths, protectedPaths, worktree: prepared.candidate, reviewId: key, review });
        if (candidates.length >= 50) break;
      }
      if (candidates.length >= 50) break;
    }
    if (!candidates.length) return { reviewed: 0, message: 'No old, unattached worktrees with unique content require human review', results: [] };
    await bb.storage.kv.set('lastSemanticReview', { at: new Date().toISOString(), candidates: candidates.map(item => ({ hostId: item.hostId, worktreePath: item.worktree!.path, fingerprint: item.worktree!.fingerprint, reviewId: item.reviewId, review: item.review })) });
    const results: unknown[] = [];
    for (let offset = 0; offset < candidates.length; offset += 20) {
      const batch = candidates.slice(offset, offset + 20);
      const response = await bb.ui.requestInput({
        threadId,
        rendererId: 'worktree-review',
        title: `Review protected worktrees (${offset + 1}-${offset + batch.length} of ${candidates.length})`,
        payload: { candidates: batch.map(item => ({
          reviewId: item.reviewId, path: item.worktree!.path, branch: item.worktree!.branch,
          ageDays: item.worktree!.ageDays,
          uniquePaths: item.worktree!.changes.filter(change => change.classification === 'unique').map(change => change.path).slice(0, 30),
          verdict: item.review.verdict, confidence: item.review.confidence,
          intent: item.review.intent, rationale: item.review.rationale,
        })) },
        timeoutMs: 60 * 60_000,
      }, { signal });
      if (response.outcome === 'cancelled') return { reviewed: candidates.length, cancelled: response.reason, results };
      const decisions = humanResponse.parse(response.value).decisions;
      const byDecisionHost = new Map<string, typeof batch>();
      for (const decision of decisions.filter(decision => decision.action === 'archive_remove')) {
        const candidate = batch.find(item => item.reviewId === decision.reviewId);
        if (!candidate) continue;
        const values = byDecisionHost.get(candidate.hostId) ?? [];
        values.push(candidate);
        byDecisionHost.set(candidate.hostId, values);
      }
      for (const [hostId, selected] of byDecisionHost) {
        const first = selected[0]!;
        const applied = await host.call('applyReviewed', {
          sourcePaths: first.sourcePaths, protectedPaths: first.protectedPaths,
          retentionDays: config.retentionDays,
          decisions: selected.map(item => ({ worktreePath: item.worktree!.path, fingerprint: item.worktree!.fingerprint })),
        }, { hostId, signal, timeoutMs: 30 * 60_000 });
        results.push(...applied.results.map(result => ({ hostId, ...result })));
      }
    }
    await bb.storage.kv.set('lastHumanReview', { at: new Date().toISOString(), reviewed: candidates.length, results });
    return { reviewed: candidates.length, results };
  }

  async function scheduleHumanReview(report: Awaited<ReturnType<typeof sourceSweep>>, signal: AbortSignal) {
    const config = await settings.get();
    if (!config.automaticReview) return;
    const candidates = report.details.filter(worktree => !worktree.primary && !worktree.protected
      && worktree.ageDays >= config.retentionDays && !worktree.changesTruncated
      && worktree.changes.some(change => change.classification === 'unique'));
    if (!candidates.length) {
      await bb.storage.kv.set('automaticReviewSignature', '');
      return;
    }
    const signature = candidates.map(item => `${item.path}\0${item.fingerprint}`).sort().join('\n');
    if (await bb.storage.kv.get('automaticReviewSignature') === signature) return;
    const allowed = new Set(config.projectIds.split(',').map(value => value.trim()).filter(Boolean));
    const projects = await bb.sdk.projects.list({ includePersonal: true, signal });
    const project = projects.find(item => (!allowed.size || allowed.has(item.id)) && item.sources.length);
    if (!project) {
      bb.log.warn('Old unique worktrees need review, but no eligible project could host the review thread');
      return;
    }
    const thread = await bb.sdk.threads.spawn({
      projectId: project.id,
      environment: { type: 'project-default' },
      visibility: 'visible',
      title: `Review ${candidates.length} protected worktree${candidates.length === 1 ? '' : 's'}`,
      pluginMetadata: { kind: 'automatic-human-review', signature },
      prompt: [
        `The Worktree Cleanup plugin found ${candidates.length} old, unattached worktree(s) with unique content.`,
        'Run `bb worktree-cleanup review` now. It will perform redacted semantic reviews and display a structured human decision form.',
        'Do not choose removal options for the user and do not run any other cleanup command. Wait for the human decision form to be submitted, then report its result.',
      ].join('\n'),
    });
    await bb.storage.kv.set('automaticReviewSignature', signature);
    await bb.storage.kv.set('automaticReviewThread', { at: new Date().toISOString(), threadId: thread.id, projectId: project.id, candidates: candidates.length });
  }
  bb.background.schedule('hourly-cleanup', '23 * * * *', async () => {
    const { automatic } = await settings.get();
    await sweep(automatic);
    const report = await sourceSweep(automatic, true);
    await scheduleHumanReview(report, controller.signal);
  });
  bb.cli.register({
    name: 'worktree-cleanup', summary: 'Audit and clean worktrees across all registered project sources',
    commands: [
      { name: 'preview', summary: 'Scan without deleting', usage: 'bb worktree-cleanup preview' },
      { name: 'run', summary: 'Scan, or explicitly request provider cleanup', usage: 'bb worktree-cleanup run [--apply]' },
      { name: 'sources', summary: 'Inspect worktrees under every registered project source', usage: 'bb worktree-cleanup sources [--apply] [--prune]' },
      { name: 'mole', summary: 'Run Mole project-purge preview against registered sources', usage: 'bb worktree-cleanup mole' },
      { name: 'review', summary: 'Run semantic review and ask for human decisions', usage: 'bb worktree-cleanup review' },
      { name: 'status', summary: 'Show settings and last scan', usage: 'bb worktree-cleanup status' },
    ],
    async run(argv, ctx) {
      try {
        if (argv.length === 1 && argv[0] === 'status') return { exitCode: 0, stdout: JSON.stringify({
          settings: await settings.get(),
          lastReport: await bb.storage.kv.get('lastReport'),
          lastSourceReport: await bb.storage.kv.get('lastSourceReport'),
          lastSemanticReview: await bb.storage.kv.get('lastSemanticReview'),
          lastHumanReview: await bb.storage.kv.get('lastHumanReview'),
          automaticReviewThread: await bb.storage.kv.get('automaticReviewThread'),
        }, null, 2) };
        if (argv[0] === 'sources' && argv.slice(1).every(value => value === '--apply' || value === '--prune') && new Set(argv.slice(1)).size === argv.slice(1).length) {
          return { exitCode: 0, stdout: JSON.stringify(await sourceSweep(argv.includes('--apply'), argv.includes('--prune'), ctx.signal), null, 2) };
        }
        if (argv.length === 1 && argv[0] === 'mole') return { exitCode: 0, stdout: JSON.stringify(await molePreview(ctx.signal), null, 2) };
        if (argv.length === 1 && argv[0] === 'review') {
          if (!ctx.threadId || !ctx.projectId || !ctx.signal) return { exitCode: 2, stderr: 'review must be run from a BB project thread' };
          return { exitCode: 0, stdout: JSON.stringify(await interactiveReview(ctx.threadId, ctx.projectId, ctx.signal), null, 2) };
        }
        const valid = argv.length === 0 || (argv.length === 1 && ['preview', 'run'].includes(argv[0]!)) || (argv.length === 2 && argv[0] === 'run' && argv[1] === '--apply');
        if (!valid) return { exitCode: 2, stderr: 'Usage: bb worktree-cleanup [preview | run [--apply] | sources [--apply] [--prune] | mole | review | status]' };
        const report = await sweep(argv.includes('--apply'), ctx.signal);
        return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
      } catch (error) { return { exitCode: 1, stderr: String(error) }; }
    },
  });
}
