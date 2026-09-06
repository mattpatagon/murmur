import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  type FeedbackSubmissionDto,
  SubmitFeedbackInputSchema,
  SubmitFeedbackOutputSchema,
} from "../src/domain/feedback-contracts.js";
import type { SubmitFeedbackCommand, SubmitFeedbackResult } from "../src/domain/feedback-models.js";
import { ListTokensOutputSchema, toTokenSummaryDto } from "../src/hosted/contracts.js";
import type { Page, TokenSummary } from "../src/hosted/control-plane-contracts.js";
import {
  MaterializationByteBudget,
  MaterializationCapacityError,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import {
  feedbackRetainedBytes,
  MAX_FEEDBACK_MATERIALIZATION_BYTES,
  MAX_TOKEN_LIST_MATERIALIZATION_BYTES,
  tokenListRetainedBytes,
} from "../src/mcp/bounded-tool-materialization.js";
import {
  FEEDBACK_INPUT,
  FIXTURE_ID,
  feedbackResult,
  TenantToolFixture,
  tokenSummary,
} from "./support/tenant-tool-materialization-fixture.js";

type Operation = "tokens" | "feedback";
const OPERATIONS: readonly Operation[] = ["tokens", "feedback"];
const HOSTED_BYTES: number = 32 * 1024 * 1024;
type Gate = { readonly promise: Promise<void>; readonly resolve: () => void };

async function call(
  fixture: TenantToolFixture,
  operation: Operation,
): Promise<CallToolResult | null> {
  return operation === "tokens" ? await fixture.listTokens() : await fixture.submitFeedback();
}

function retainedBytes(result: CallToolResult | null, operation: Operation): number {
  if (result === null) throw new Error("Expected a tool result");
  return operation === "tokens"
    ? tokenListRetainedBytes(ListTokensOutputSchema.parse(result.structuredContent))
    : feedbackRetainedBytes(SubmitFeedbackOutputSchema.parse(result.structuredContent));
}

for (const operation of OPERATIONS) {
  test(`${operation} rejects a full ledger before storage or reporter authorization`, async (): Promise<void> => {
    const fixture: TenantToolFixture = new TenantToolFixture();
    const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
    const held: ReturnType<MaterializationByteBudget["reserve"]> = budget.reserve(HOSTED_BYTES);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const finishHandler: () => void = scope.startHandler();
    try {
      const outcome: unknown = await withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await call(fixture, operation),
      ).catch((error: unknown): unknown => error);
      expect(fixture.tokenRequests).toHaveLength(0);
      expect(fixture.feedbackRequests).toHaveLength(0);
      expect(fixture.authorizationRequests).toHaveLength(0);
      expect(outcome).toBeInstanceOf(MaterializationCapacityError);
      expect(budget.reservedBytes).toBe(HOSTED_BYTES);
      held.release();
      const recovered: CallToolResult | null = await withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await call(fixture, operation),
      );
      expect(budget.reservedBytes).toBe(retainedBytes(recovered, operation));
    } finally {
      held.release();
      finishHandler();
      scope.finishResponse();
    }
  });

  test(`${operation} retains success through both handler and response completion`, async (): Promise<void> => {
    for (const responseFirst of [false, true]) {
      const fixture: TenantToolFixture = new TenantToolFixture();
      const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
      const scope: MaterializationScope = new MaterializationScope(budget);
      const finishHandler: () => void = scope.startHandler();
      try {
        const result: CallToolResult | null = await withMaterializationScope(
          scope,
          async (): Promise<CallToolResult | null> => await call(fixture, operation),
        );
        const bytes: number = retainedBytes(result, operation);
        expect(budget.reservedBytes).toBe(bytes);
        expect(bytes).toBeGreaterThan(0);
        if (responseFirst) scope.finishResponse();
        else finishHandler();
        expect(budget.reservedBytes).toBe(bytes);
        if (responseFirst) finishHandler();
        else scope.finishResponse();
        expect(budget.reservedBytes).toBe(0);
      } finally {
        finishHandler();
        scope.finishResponse();
      }
    }
  });

  test(`${operation} releases storage and output-validation failures and recovers`, async (): Promise<void> => {
    const fixture: TenantToolFixture = new TenantToolFixture();
    const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const finishHandler: () => void = scope.startHandler();
    const tokenAction: TenantToolFixture["tokenAction"] = fixture.tokenAction;
    const feedbackAction: TenantToolFixture["feedbackAction"] = fixture.feedbackAction;
    const failure: Error = new Error("Fixture storage failure");
    try {
      fixture.tokenAction = async (): Promise<Page<TokenSummary>> => {
        throw failure;
      };
      fixture.feedbackAction = async (): Promise<SubmitFeedbackResult> => {
        throw failure;
      };
      await expect(
        withMaterializationScope(
          scope,
          async (): Promise<CallToolResult | null> => await call(fixture, operation),
        ),
      ).rejects.toBe(failure);
      expect(budget.reservedBytes).toBe(0);
      fixture.tokenAction = async (): Promise<Page<TokenSummary>> => ({
        items: [tokenSummary("")],
        nextCursor: null,
      });
      fixture.feedbackAction = async (
        command: SubmitFeedbackCommand,
      ): Promise<SubmitFeedbackResult> => {
        const result: SubmitFeedbackResult = feedbackResult(command);
        return { ...result, submission: { ...result.submission, title: { value: "" } } };
      };
      await expect(
        withMaterializationScope(
          scope,
          async (): Promise<CallToolResult | null> => await call(fixture, operation),
        ),
      ).rejects.toThrow();
      expect(budget.reservedBytes).toBe(0);
      fixture.tokenAction = tokenAction;
      fixture.feedbackAction = feedbackAction;
      const result: CallToolResult | null = await withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await call(fixture, operation),
      );
      expect(budget.reservedBytes).toBe(retainedBytes(result, operation));
    } finally {
      finishHandler();
      scope.finishResponse();
    }
  });
}

type PendingStage = "tokens" | "feedback-authorization" | "feedback-storage";
const PENDING_STAGES: readonly PendingStage[] = [
  "tokens",
  "feedback-authorization",
  "feedback-storage",
];

for (const stage of PENDING_STAGES) {
  test(`${stage} remains charged after cancellation until actual work settles`, async (): Promise<void> => {
    for (const fails of [false, true]) {
      const fixture: TenantToolFixture = new TenantToolFixture();
      const operation: Operation = stage === "tokens" ? "tokens" : "feedback";
      const maximum: number =
        operation === "tokens"
          ? MAX_TOKEN_LIST_MATERIALIZATION_BYTES
          : MAX_FEEDBACK_MATERIALIZATION_BYTES;
      const budget: MaterializationByteBudget = new MaterializationByteBudget(maximum);
      const scope: MaterializationScope = new MaterializationScope(budget);
      const finishHandler: () => void = scope.startHandler();
      const entered: Gate = Promise.withResolvers<void>();
      const release: Gate = Promise.withResolvers<void>();
      const failure: Error = new Error("Fixture pending failure");
      const wait: () => Promise<void> = async (): Promise<void> => {
        entered.resolve();
        await release.promise;
        if (fails) throw failure;
      };
      fixture.tokenAction = async (): Promise<Page<TokenSummary>> => {
        await wait();
        return { items: [tokenSummary()], nextCursor: null };
      };
      if (stage === "feedback-authorization") fixture.authorizationAction = wait;
      if (stage === "feedback-storage") {
        fixture.feedbackAction = async (
          command: SubmitFeedbackCommand,
        ): Promise<SubmitFeedbackResult> => {
          await wait();
          return feedbackResult(command, true);
        };
      }
      const request: Promise<unknown> = withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await call(fixture, operation),
      ).catch((error: unknown): unknown => error);
      const competing: MaterializationScope = new MaterializationScope(budget);
      try {
        await entered.promise;
        expect(budget.reservedBytes).toBe(maximum);
        // Model an abandoned SDK promise and closed response, not a stopped backend operation.
        finishHandler();
        scope.finishResponse();
        expect(budget.reservedBytes).toBe(maximum);
        const other: TenantToolFixture = new TenantToolFixture();
        await expect(
          withMaterializationScope(
            competing,
            async (): Promise<CallToolResult | null> => await call(other, operation),
          ),
        ).rejects.toBeInstanceOf(MaterializationCapacityError);
        expect(other.tokenRequests).toHaveLength(0);
        expect(other.feedbackRequests).toHaveLength(0);
        expect(other.authorizationRequests).toHaveLength(0);
        release.resolve();
        const outcome: unknown = await request;
        if (fails) expect(outcome).toBe(failure);
        else expect(outcome).not.toBeInstanceOf(Error);
        expect(budget.reservedBytes).toBe(0);
        await withMaterializationScope(
          competing,
          async (): Promise<CallToolResult | null> => await call(other, operation),
        );
        expect(budget.reservedBytes).toBeGreaterThan(0);
      } finally {
        release.resolve();
        await request;
        finishHandler();
        scope.finishResponse();
        competing.finishResponse();
      }
    }
  });
}

test("token materialization preserves tenant, limit, exact order, cursor and empty output", async (): Promise<void> => {
  const fixture: TenantToolFixture = new TenantToolFixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const otherId: string = "00000000-0000-4000-8000-000000000002";
  const items: TokenSummary[] = [
    { ...tokenSummary("newer"), tokenId: otherId },
    tokenSummary("older"),
  ];
  fixture.tokenAction = async (): Promise<Page<TokenSummary>> => ({
    items,
    nextCursor: FIXTURE_ID,
  });
  try {
    const result: CallToolResult | null = await withMaterializationScope(
      scope,
      async (): Promise<CallToolResult | null> =>
        await fixture.listTokens({ cursor: otherId, limit: 2 }),
    );
    if (result === null) throw new Error("Expected token result");
    expect(ListTokensOutputSchema.parse(result.structuredContent)).toEqual({
      next_cursor: FIXTURE_ID,
      tokens: items.map(toTokenSummaryDto),
    });
    expect(fixture.tokenRequests).toEqual([
      { principal: fixture.principal, cursor: otherId, limit: 2 },
    ]);
    scope.finishResponse();
    expect(budget.reservedBytes).toBe(0);
    fixture.tokenAction = async (): Promise<Page<TokenSummary>> => ({
      items: [],
      nextCursor: null,
    });
    const emptyScope: MaterializationScope = new MaterializationScope(budget);
    try {
      const empty: CallToolResult | null = await withMaterializationScope(
        emptyScope,
        async (): Promise<CallToolResult | null> => await fixture.listTokens({}),
      );
      if (empty === null) throw new Error("Expected empty token result");
      expect(ListTokensOutputSchema.parse(empty.structuredContent)).toEqual({
        next_cursor: null,
        tokens: [],
      });
      expect(fixture.tokenRequests.at(-1)).toEqual({
        principal: fixture.principal,
        cursor: null,
        limit: 100,
      });
      expect(budget.reservedBytes).toBe(
        tokenListRetainedBytes(ListTokensOutputSchema.parse(empty.structuredContent)),
      );
    } finally {
      emptyScope.finishResponse();
    }
  } finally {
    scope.finishResponse();
  }
});

test("feedback replay preserves submission and idempotency while admission precedes authorization", async (): Promise<void> => {
  const fixture: TenantToolFixture = new TenantToolFixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const failure: Error = new Error("Fixture authorization failure");
  fixture.authorizationAction = async (): Promise<void> => {
    expect(budget.reservedBytes).toBe(MAX_FEEDBACK_MATERIALIZATION_BYTES);
    throw failure;
  };
  try {
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await fixture.submitFeedback(),
      ),
    ).rejects.toBe(failure);
    expect(fixture.feedbackRequests).toHaveLength(0);
    expect(budget.reservedBytes).toBe(0);
    fixture.authorizationAction = async (): Promise<void> => {};
    const expectedDescription: string = SubmitFeedbackInputSchema.parse(FEEDBACK_INPUT).description;
    let first: FeedbackSubmissionDto | null = null;
    for (const duplicate of [false, true]) {
      fixture.feedbackAction = async (
        command: SubmitFeedbackCommand,
      ): Promise<SubmitFeedbackResult> => feedbackResult(command, duplicate);
      const result: CallToolResult | null = await withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await fixture.submitFeedback(),
      );
      if (result === null) throw new Error("Expected feedback result");
      const output: ReturnType<typeof SubmitFeedbackOutputSchema.parse> =
        SubmitFeedbackOutputSchema.parse(result.structuredContent);
      expect(output.duplicate).toBe(duplicate);
      if (!duplicate) first = output.submission;
      else {
        if (first === null) throw new Error("Expected the original feedback submission");
        expect(output.submission).toEqual(first);
      }
      expect(output.status).toBe("stored");
      expect(output.submission.description).toBe(expectedDescription);
    }
    expect(
      fixture.feedbackRequests.map((command: SubmitFeedbackCommand): string | null =>
        command.idempotencyKey === null ? null : command.idempotencyKey.value,
      ),
    ).toEqual(["same-submission", "same-submission"]);
    expect(budget.reservedBytes).toBeGreaterThan(0);
  } finally {
    scope.finishResponse();
  }
  expect(budget.reservedBytes).toBe(0);
});

test("invalid tool input makes no downstream calls or reservations", async (): Promise<void> => {
  const fixture: TenantToolFixture = new TenantToolFixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(HOSTED_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  try {
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> => await fixture.listTokens({ limit: 501 }),
      ),
    ).rejects.toThrow();
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> =>
          await fixture.submitFeedback({ ...FEEDBACK_INPUT, reporter_id: "invalid reporter" }),
      ),
    ).rejects.toThrow();
    expect(fixture.tokenRequests).toHaveLength(0);
    expect(fixture.feedbackRequests).toHaveLength(0);
    expect(fixture.authorizationRequests).toHaveLength(0);
    expect(budget.reservedBytes).toBe(0);
  } finally {
    scope.finishResponse();
  }
});
