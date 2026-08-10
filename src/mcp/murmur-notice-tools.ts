import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type ListNoticesInput,
  ListNoticesInputSchema,
  type ListNoticesOutput,
  ListNoticesOutputSchema,
  listNoticesQuery,
  type NoticeMutationOutput,
  NoticeMutationOutputSchema,
  type PostNoticeInput,
  PostNoticeInputSchema,
  postNoticeCommand,
  type ResolveNoticeInput,
  ResolveNoticeInputSchema,
  resolveNoticeCommand,
  toNoticeDto,
  toListNoticesOutput,
  type WithdrawNoticeInput,
  WithdrawNoticeInputSchema,
  withdrawNoticeCommand,
} from "../domain/notice-contracts.js";
import { type AgentId, RepositoryName } from "../domain/value-objects.js";
import type {
  ListNoticesResult,
  PostNoticeResult,
  ResolveNoticeResult,
  WithdrawNoticeResult,
} from "../domain/notice-models.js";
import type { MessageStore } from "../storage/message-store.js";
import { toolResult } from "./murmur-tool-results.js";

const NAMES: ReadonlySet<string> = new Set([
  "post_notice",
  "list_notices",
  "resolve_notice",
  "withdraw_notice",
]);

function repository(explicit: string | undefined, fallback: RepositoryName | null): RepositoryName {
  if (explicit !== undefined) return RepositoryName.parse(explicit);
  if (fallback === null) {
    throw new Error(
      "Notice repository is required. Supply repository or configure MURMUR_REPOSITORY/X-Murmur-Repository.",
    );
  }
  return fallback;
}

export async function callNoticeTool(
  name: string,
  argumentsValue: unknown,
  store: MessageStore,
  repositoryName: RepositoryName | null,
  authorizeActorId: (input: string) => Promise<AgentId>,
): Promise<CallToolResult | null> {
  if (!NAMES.has(name)) return null;
  if (name === "post_notice") {
    const input: PostNoticeInput = PostNoticeInputSchema.parse(argumentsValue);
    const result: PostNoticeResult = await store.postNotice({
      ...postNoticeCommand(input, repository(input.repository, repositoryName)),
      actorId: await authorizeActorId(input.actor_id),
    });
    const output: NoticeMutationOutput = NoticeMutationOutputSchema.parse({
      duplicate: result.duplicate,
      notice: toNoticeDto(result.notice),
    });
    return toolResult(output);
  }
  if (name === "list_notices") {
    const input: ListNoticesInput = ListNoticesInputSchema.parse(argumentsValue);
    const result: ListNoticesResult = await store.listNotices({
      ...listNoticesQuery(input, repository(input.repository, repositoryName)),
      actorId: await authorizeActorId(input.actor_id),
    });
    const output: ListNoticesOutput = ListNoticesOutputSchema.parse(toListNoticesOutput(result));
    return toolResult(output);
  }
  if (name === "resolve_notice") {
    const input: ResolveNoticeInput = ResolveNoticeInputSchema.parse(argumentsValue);
    const result: ResolveNoticeResult = await store.resolveNotice({
      ...resolveNoticeCommand(input, repository(input.repository, repositoryName)),
      actorId: await authorizeActorId(input.actor_id),
    });
    return toolResult(
      NoticeMutationOutputSchema.parse({
        duplicate: result.alreadyResolved,
        notice: toNoticeDto(result.notice),
      }),
    );
  }
  const input: WithdrawNoticeInput = WithdrawNoticeInputSchema.parse(argumentsValue);
  const result: WithdrawNoticeResult = await store.withdrawNotice({
    ...withdrawNoticeCommand(input, repository(input.repository, repositoryName)),
    actorId: await authorizeActorId(input.actor_id),
  });
  return toolResult(
    NoticeMutationOutputSchema.parse({
      duplicate: result.alreadyWithdrawn,
      notice: toNoticeDto(result.notice),
    }),
  );
}
