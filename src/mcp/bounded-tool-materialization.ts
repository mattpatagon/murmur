import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SubmitFeedbackOutput } from "../domain/feedback-contracts.js";
import type { ListTokensOutput } from "../hosted/contracts.js";
import {
  type MaterializationReservation,
  reserveMaterializationBytes,
} from "../materialization-budget.js";
import { toolResult } from "./murmur-tool-results.js";

export const MAX_TOKEN_LIST_MATERIALIZATION_BYTES: number = 8 * 1024 * 1024;
export const TOKEN_LIST_ROW_BYTES: number = 8 * 1024;
export const TOOL_ENVELOPE_BYTES: number = 8 * 1024;
export const MAX_FEEDBACK_MATERIALIZATION_BYTES: number = 2 * 1024 * 1024;

export function tokenListRetainedBytes(output: ListTokensOutput): number {
  if (output.tokens.length > 500) throw new Error("Invalid token page length");
  // Bounded names/IDs, ASCII repository/key/role fields and normalized timestamps fit per row.
  return TOOL_ENVELOPE_BYTES + output.tokens.length * TOKEN_LIST_ROW_BYTES;
}

export function feedbackRetainedBytes(output: SubmitFeedbackOutput): number {
  const submission: SubmitFeedbackOutput["submission"] = output.submission;
  // A UTF-16 unit expands to at most six JSON bytes plus seven in nested tool text.
  // This also covers lone surrogates; UTF-8 length alone undercounts their escaping.
  return (
    TOOL_ENVELOPE_BYTES +
    13 *
      (submission.description.length + submission.title.length + submission.context.branch.length)
  );
}

export async function materializedToolResult<T extends Record<string, unknown>>(
  maximumBytes: number,
  action: () => Promise<T>,
  estimate: (output: T) => number,
): Promise<CallToolResult> {
  const reservation: MaterializationReservation = reserveMaterializationBytes(maximumBytes);
  try {
    const output: T = await action();
    const bytes: number = estimate(output);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumBytes) {
      throw new Error("Invalid tool materialization estimate");
    }
    const result: CallToolResult = toolResult(output);
    reservation.settle(bytes);
    return result;
  } catch (error: unknown) {
    // An outer cancellation cannot release a still-running authorization or storage operation.
    reservation.fail();
    throw error;
  }
}
