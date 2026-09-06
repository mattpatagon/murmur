import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type SubmitFeedbackInput,
  SubmitFeedbackInputSchema,
  type SubmitFeedbackOutput,
  SubmitFeedbackOutputSchema,
  submitFeedbackCommand,
  toFeedbackSubmissionDto,
} from "../domain/feedback-contracts.js";
import type { SubmitFeedbackCommand, SubmitFeedbackResult } from "../domain/feedback-models.js";
import type { AgentClient, AgentId, BranchName, RepositoryName } from "../domain/value-objects.js";
import type { MessageStore } from "../storage/message-store.js";
import {
  feedbackRetainedBytes,
  MAX_FEEDBACK_MATERIALIZATION_BYTES,
  materializedToolResult,
} from "./bounded-tool-materialization.js";
import { type RequiredDataContext, requiredDataContext } from "./murmur-data-tool-helpers.js";

const FEEDBACK_TOOL_NAMES: ReadonlySet<string> = new Set<string>(["submit_feedback"]);

export async function callFeedbackTool(
  name: string,
  argumentsValue: unknown,
  store: MessageStore,
  fallback: {
    readonly branchName: BranchName | null;
    readonly client: AgentClient | null;
    readonly repositoryName: RepositoryName | null;
  },
  authorizedReporterId: (input: string) => Promise<AgentId>,
): Promise<CallToolResult | null> {
  if (!FEEDBACK_TOOL_NAMES.has(name)) return null;
  const input: SubmitFeedbackInput = SubmitFeedbackInputSchema.parse(argumentsValue);
  const submissionContext: RequiredDataContext = requiredDataContext(
    input.context,
    fallback,
    "Feedback",
  );
  const parsed: SubmitFeedbackCommand = submitFeedbackCommand(input, submissionContext);
  return await materializedToolResult(
    MAX_FEEDBACK_MATERIALIZATION_BYTES,
    async (): Promise<SubmitFeedbackOutput> => {
      const command: SubmitFeedbackCommand = {
        ...parsed,
        reporterId: await authorizedReporterId(input.reporter_id),
      };
      const result: SubmitFeedbackResult = await store.submitFeedback(command);
      return SubmitFeedbackOutputSchema.parse({
        duplicate: result.duplicate,
        status: "stored",
        submission: toFeedbackSubmissionDto(result.submission),
      });
    },
    feedbackRetainedBytes,
  );
}
