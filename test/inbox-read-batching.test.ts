import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { type InboxOutput, InboxOutputSchema } from "../src/domain/contracts.js";
import { UnknownAgentError } from "../src/domain/errors.js";
import {
  type MessageHistoryOutput,
  MessageHistoryOutputSchema,
} from "../src/domain/history-contracts.js";
import {
  MaterializationByteBudget,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { MurmurApplication } from "../src/mcp/murmur-application.js";
import { callDataTool } from "../src/mcp/murmur-data-tools.js";
import { InboxPageCapacityError, MAX_INBOX_PAGE_BYTES } from "../src/storage/inbox-page-budget.js";
import {
  type DeferredRead,
  deferred,
  InboxReadFixture,
  READ_AGENT,
  READ_BYTES,
  READ_NOW,
  type ReadStatement,
} from "./support/inbox-read-fixture.js";
import { callValidated } from "./support/mcp-client-harness.js";

for (const method of ["get_messages", "get_message_history", "resources/read"]) {
  test(`${method} shares one tenant transaction and validated agent for its page and version`, async (): Promise<void> => {
    const fixture: InboxReadFixture = new InboxReadFixture();
    const application: MurmurApplication = new MurmurApplication({
      store: fixture.store,
      branchName: null,
      client: null,
      repositoryName: null,
    });
    const client: Client = new Client({ name: "paired-inbox", version: "1.0.0" });
    const [clientTransport, serverTransport]: [InMemoryTransport, InMemoryTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await application.server.connect(serverTransport);
      await client.connect(clientTransport);
      if (method === "resources/read") {
        const output: ReadResourceResult = await client.readResource({
          uri: `murmur://inbox/${READ_AGENT.value}`,
        });
        const content: ReadResourceResult["contents"][number] | undefined = output.contents[0];
        if (content === undefined || !("text" in content) || typeof content.text !== "string")
          throw new Error("Missing inbox resource text");
        const parsed: unknown = JSON.parse(content.text);
        expect(InboxOutputSchema.parse(parsed).inbox_version).toBe(17);
      } else if (method === "get_message_history") {
        fixture.row = { ...fixture.row, recipient_generation: 7 };
        const output: MessageHistoryOutput = await callValidated(
          client,
          method,
          {
            agent_id: READ_AGENT.value,
            generation: 7,
            unread_only: true,
            thread_id: "selected-thread",
            after_sequence: 2,
            limit: 1,
          },
          MessageHistoryOutputSchema,
        );
        expect(output.generation).toBe(7);
        expect(output.inbox_version).toBe(17);
        expect(output.messages).toHaveLength(1);
      } else {
        const output: InboxOutput = await callValidated(
          client,
          method,
          {
            agent_id: READ_AGENT.value,
            unread_only: true,
            thread_id: "selected-thread",
            after_sequence: 2,
            limit: 1,
          },
          InboxOutputSchema,
        );
        expect(output.inbox_version).toBe(17);
        expect(output.messages).toHaveLength(1);
      }
      expect(fixture.transactions).toHaveLength(2);
      expect(fixture.completedTransactions).toBe(2);
      expect(fixture.clockCalls).toBe(1);
      const paired: ReadStatement[] | undefined = fixture.transactions[1];
      if (paired === undefined) throw new Error("Missing paired read transaction");
      expect(paired).toHaveLength(3);
      const first: ReadStatement | undefined = paired[0];
      if (first === undefined) throw new Error("Missing tenant context query");
      expect(first.text).toContain("set_config");
      const pruning: ReadStatement[] | undefined = fixture.transactions[0];
      if (pruning === undefined) throw new Error("Missing expiry preflight transaction");
      const preflight: ReadStatement | undefined = pruning[1];
      if (preflight === undefined) throw new Error("Missing fresh expiry preflight");
      expect(preflight.text).toContain("AS candidates");
      expect(preflight.values).toContain(READ_NOW.toISOString());
      expect(
        paired.filter((statement: ReadStatement): boolean => statement.text.includes("set_config")),
      ).toHaveLength(1);
      const page: ReadStatement | undefined = paired.find((statement: ReadStatement): boolean =>
        statement.text.includes("WITH candidates AS MATERIALIZED"),
      );
      if (page === undefined) throw new Error("Missing page and independent version query");
      expect(page.text).toContain("AS inbox_version");
      expect(page.values).toContain(method === "get_message_history" ? 7 : 1);
      const fragments: string[] = page.text.split("?");
      const generations: unknown[] = page.values.filter(
        (_value: unknown, index: number): boolean => {
          const fragment: string | undefined = fragments[index];
          return fragment !== undefined && fragment.endsWith("recipient_generation = ");
        },
      );
      expect(generations).toEqual(method === "get_message_history" ? [7, 7, 7] : [1, 1, 1]);
      const versionStart: number = page.text.indexOf("high_water AS MATERIALIZED");
      const versionEnd: number = page.text.indexOf("SELECT budget.estimated_page_bytes");
      expect(versionStart).toBeGreaterThan(0);
      expect(versionEnd).toBeGreaterThan(versionStart);
      const versionText: string = page.text.slice(versionStart, versionEnd);
      expect(versionText).toContain("murmur.messages");
      expect(versionText).toContain("murmur.e2ee_messages");
      expect(versionText).toContain("MAX(active.tenant_sequence)");
      expect(versionText).not.toContain("thread_id");
      expect(versionText).not.toContain("read_at");
      expect(versionText).not.toContain("LIMIT");
      expect(page.values).toContain(READ_NOW.toISOString());
      if (method !== "resources/read") {
        expect(page.values).toContain("selected-thread");
        expect(page.values).toContain(true);
        expect(page.values).toContain(2);
      }
    } finally {
      try {
        await client.close();
      } finally {
        await application.close();
      }
    }
  });
}

test("unknown agents fail before payload reads and oversized pages need no separate version query", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  try {
    fixture.agent = null;
    await expect(
      callDataTool("get_messages", { agent_id: READ_AGENT.value }, fixture.context()),
    ).rejects.toBeInstanceOf(UnknownAgentError);
    expect(budget.reservedBytes).toBe(0);
    expect(
      fixture
        .statements()
        .some((statement: ReadStatement): boolean =>
          statement.text.includes("WITH candidates AS MATERIALIZED"),
        ),
    ).toBe(false);
    fixture.agent = {
      agent_id: READ_AGENT.value,
      authority: "peer",
      closed_at: null,
      close_reason: null,
      created_at: READ_NOW.toISOString(),
      display_name: "Reader",
      generation: 1,
      last_seen_at: READ_NOW.toISOString(),
      lease_expires_at: null,
      live_session_count: 0,
      metadata_json: "{}",
      state: "inactive",
    };
    fixture.pageOverride = [{ estimated_page_bytes: MAX_INBOX_PAGE_BYTES + 1 }];
    await expect(
      withMaterializationScope(
        scope,
        async (): Promise<CallToolResult | null> =>
          await callDataTool("get_messages", { agent_id: READ_AGENT.value }, fixture.context()),
      ),
    ).rejects.toBeInstanceOf(InboxPageCapacityError);
    expect(budget.reservedBytes).toBe(0);
    expect(
      fixture
        .statements()
        .some((statement: ReadStatement): boolean =>
          statement.text.trimStart().startsWith("SELECT COALESCE(MAX(active.tenant_sequence)"),
        ),
    ).toBe(false);
  } finally {
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

test("a returned page remains charged during blocked transaction completion after its response is canceled", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  const entered: DeferredRead = deferred();
  const release: DeferredRead = deferred();
  fixture.completionAction = async (): Promise<void> => {
    entered.resolve();
    await release.promise;
  };
  const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
  const scope: MaterializationScope = new MaterializationScope(budget);
  const complete: () => void = scope.startHandler();
  const operation: Promise<CallToolResult | null> = withMaterializationScope(
    scope,
    async (): Promise<CallToolResult | null> =>
      await callDataTool("get_messages", { agent_id: READ_AGENT.value }, fixture.context()),
  );
  try {
    await entered.promise;
    expect(budget.reservedBytes).toBe(READ_BYTES);
    scope.finishResponse();
    expect(budget.reservedBytes).toBe(READ_BYTES);
    expect(fixture.completedTransactions).toBe(1);
    release.resolve();
    await operation;
    expect(budget.reservedBytes).toBe(READ_BYTES);
    complete();
    expect(budget.reservedBytes).toBe(0);
  } finally {
    release.resolve();
    await operation;
    complete();
    scope.finishResponse();
    await fixture.store.close();
  }
});

test("a populated wait_for_messages read does not fetch an unused inbox version", async (): Promise<void> => {
  const fixture: InboxReadFixture = new InboxReadFixture();
  try {
    const result: CallToolResult | null = await callDataTool(
      "wait_for_messages",
      { agent_id: READ_AGENT.value },
      fixture.context(),
    );
    expect(result).not.toBeNull();
    expect(
      fixture
        .statements()
        .some((statement: ReadStatement): boolean => statement.text.includes("AS version")),
    ).toBe(false);
    expect(fixture.transactions).toHaveLength(2);
  } finally {
    await fixture.store.close();
  }
});

test("empty pages reserve no bytes while completion failure cannot prematurely release a materialized page", async (): Promise<void> => {
  for (const empty of [false, true]) {
    const fixture: InboxReadFixture = new InboxReadFixture();
    if (empty) fixture.pageOverride = [];
    fixture.completionAction = async (): Promise<void> => {
      throw new Error("Read transaction fixture failed");
    };
    const budget: MaterializationByteBudget = new MaterializationByteBudget(MAX_INBOX_PAGE_BYTES);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const complete: () => void = scope.startHandler();
    try {
      await expect(
        withMaterializationScope(
          scope,
          async (): Promise<CallToolResult | null> =>
            await callDataTool("get_messages", { agent_id: READ_AGENT.value }, fixture.context()),
        ),
      ).rejects.toThrow("Read transaction fixture failed");
      expect(budget.reservedBytes).toBe(empty ? 0 : READ_BYTES);
      complete();
      expect(budget.reservedBytes).toBe(empty ? 0 : READ_BYTES);
      scope.finishResponse();
      expect(budget.reservedBytes).toBe(0);
    } finally {
      complete();
      scope.finishResponse();
      await fixture.store.close();
    }
  }
});
