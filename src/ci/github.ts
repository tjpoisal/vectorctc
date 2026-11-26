import fs from "node:fs";

import { COMMENT_MARKER, ciMarkdown, type CiReport } from "./ci.js";

export interface GitHubContext {
  token: string;
  repository: string;
  prNumber: number;
  apiBase: string;
}

export function githubContextFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubContext | null {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  let prNumber = Number(env.CTC_PR_NUMBER ?? NaN);
  if (!Number.isFinite(prNumber) && env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { number?: number }; number?: number };
    prNumber = Number(event.pull_request?.number ?? event.number ?? NaN);
  }
  if (!token || !repository || !Number.isFinite(prNumber)) return null;
  return { token, repository, prNumber, apiBase: env.GITHUB_API_URL ?? "https://api.github.com" };
}

async function call(ctx: GitHubContext, method: string, route: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(`${ctx.apiBase}${route}`, {
    method,
    headers: { authorization: `Bearer ${ctx.token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${route}: HTTP ${res.status}`);
  return res.status === 204 ? null : ((await res.json()) as unknown);
}

/** One sticky comment per PR (found by marker and updated in place), plus an APPROVE review when the report allows it. */
export async function publishToGitHub(report: CiReport, ctx: GitHubContext, fetchImpl: typeof fetch = fetch): Promise<{ comment: "created" | "updated"; approved: boolean }> {
  const body = ciMarkdown(report);
  const comments = (await call(ctx, "GET", `/repos/${ctx.repository}/issues/${ctx.prNumber}/comments?per_page=100`, undefined, fetchImpl)) as Array<{ id: number; body?: string }>;
  const mine = comments.find((item) => item.body?.includes(COMMENT_MARKER));
  if (mine) await call(ctx, "PATCH", `/repos/${ctx.repository}/issues/comments/${mine.id}`, { body }, fetchImpl);
  else await call(ctx, "POST", `/repos/${ctx.repository}/issues/${ctx.prNumber}/comments`, { body }, fetchImpl);
  let approved = false;
  if (report.risk.approvable) {
    const factors = report.risk.factors.map((factor) => `- ${factor.id}: ${factor.detail}`).join("\n");
    await call(ctx, "POST", `/repos/${ctx.repository}/pulls/${ctx.prNumber}/reviews`, { event: "APPROVE", body: `VectorCTC auto-approve (opt-in): every risk factor passed.\n\n${factors}` }, fetchImpl);
    approved = true;
  }
  return { comment: mine ? "updated" : "created", approved };
}
