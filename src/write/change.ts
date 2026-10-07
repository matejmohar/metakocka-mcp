/**
 * Saving a change to something that already exists, or a message: one call
 * to the endpoint the draft names, never retried, then a check that it took
 * effect. Used for updates of documents, partners and products, shipping,
 * complaints and messages; each drafting module says which endpoint and how
 * to check.
 */
import type { MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import type { CommitContext, CommitOutcome } from "./commit.js";
import type { Draft } from "./drafts.js";

export interface ChangeCheck {
  /** Whether the change is in place now. */
  done: boolean;
  /** Differences worth a warning even when done. */
  warnings?: string[];
}

export interface ChangeSpec {
  /** E.g. "update_document", or "../send_message" for calls outside /v1. */
  endpoint: string;
  /** Turns Metakocka's answer into warnings and details, or throws when it reports a failure inside a 0 opr_code. */
  interpret?: (response: MkRecord) => { warnings?: string[]; details?: Record<string, unknown>; mkId?: string; number?: string };
  /**
   * Reads Metakocka to tell whether the change took effect. Without it, a call
   * that didn't answer can only be checked by the user (messages, labels).
   */
  check?: (client: MetakockaClient) => Promise<ChangeCheck>;
  /** What to look at in Metakocka when the outcome is unknown and can't be checked here. */
  manualCheck?: string;
}

export async function commitChange(ctx: CommitContext, draft: Draft): Promise<CommitOutcome> {
  const spec = draft.change!;
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  draft.status = "committing";
  await ctx.journal({ ...base, event: "attempt", endpoint: spec.endpoint, payload: draft.payload });
  let response: MkRecord;
  try {
    response = await ctx.client.call(spec.endpoint, draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MetakockaError && error.oprCode !== undefined) {
      draft.status = "open";
      await ctx.journal({ ...base, event: "failed", error: message });
      return { status: "rejected", message: `Metakocka refused it; nothing was changed: ${message}` };
    }
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", error: message });
    return { status: "unknown", message: unknownMessage(message, spec) };
  }
  let interpreted: ReturnType<NonNullable<ChangeSpec["interpret"]>> = {};
  try {
    interpreted = spec.interpret?.(response) ?? {};
  } catch (error) {
    // The call went through but Metakocka reports the change failed (e.g. per order in a list).
    draft.status = "open";
    const message = error instanceof Error ? error.message : String(error);
    await ctx.journal({ ...base, event: "failed", error: message, response });
    return { status: "rejected", message };
  }
  return finish(ctx, draft, interpreted, [...(interpreted.warnings ?? [])]);
}

/** After an unknown outcome: check whether the change took effect, where that can be checked. */
export async function resolveUnknownChange(ctx: CommitContext, draft: Draft): Promise<CommitOutcome | { status: "not_found" } | { status: "ambiguous"; candidates: string[] }> {
  const spec = draft.change!;
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  if (!spec.check) return { status: "ambiguous", candidates: [spec.manualCheck ?? "check in Metakocka"] };
  const state = await spec.check(ctx.client);
  await ctx.journal({ ...base, event: "resolved", found: state.done });
  if (!state.done) {
    draft.status = "open";
    return { status: "not_found" };
  }
  return finish(ctx, draft, {}, ["The call had not answered; the change was found in Metakocka afterwards.", ...(state.warnings ?? [])], true);
}

async function finish(
  ctx: CommitContext,
  draft: Draft,
  interpreted: { details?: Record<string, unknown>; mkId?: string; number?: string },
  warnings: string[],
  checked = false,
): Promise<CommitOutcome> {
  const spec = draft.change!;
  const target = draft.target;
  draft.status = "committed";
  draft.result = { mkId: interpreted.mkId ?? target?.mkId, number: interpreted.number ?? target?.number, details: interpreted.details };
  if (spec.check && !checked) {
    try {
      const state = await spec.check(ctx.client);
      if (!state.done) warnings.push("CHECK IN METAKOCKA: Metakocka accepted the change, but reading it back doesn't show it.");
      warnings.push(...(state.warnings ?? []));
    } catch (error) {
      warnings.push(`Saved, but reading it back to check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ctx.journal({ draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation, event: "committed", mk_id: draft.result.mkId, number: draft.result.number, warnings });
  return {
    status: "created",
    mk_id: draft.result.mkId ?? "",
    ...(draft.result.number ? { number: draft.result.number } : {}),
    ...(interpreted.details ? { details: interpreted.details } : {}),
    warnings,
  };
}

function unknownMessage(reason: string, spec: ChangeSpec): string {
  return (
    `It is not known whether this went through (${reason}). Do NOT draft it again. ` +
    (spec.check
      ? "Call commit_document with the same draft_id: it first checks Metakocka."
      : `It can't be checked automatically: ${spec.manualCheck ?? "check in Metakocka"}, then discard_draft.`)
  );
}
