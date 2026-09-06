import type { Database, SQLQueryBindings } from "bun:sqlite";
import { expect, type Mock, spyOn, test } from "bun:test";

import type { EncryptedEnvelopeDto } from "../src/e2ee/wire-contracts.js";
import {
  MaterializationByteBudget,
  MaterializationCapacityError,
  MaterializationScope,
  withMaterializationScope,
} from "../src/materialization-budget.js";
import { commitSqliteEncryptedBroadcast } from "../src/storage/sqlite-e2ee-broadcast-finalize.js";
import { readSqliteE2eeUsage } from "../src/storage/sqlite-e2ee-usage.js";
import {
  FINALIZE_AUTHORIZATION,
  FINALIZE_NOW,
  type FinalizeFixtureDelivery,
  type SqliteFinalizeFixture,
  withSqliteFinalizeFixture,
} from "./support/e2ee-broadcast-finalize-fixture.js";

function commit(fixture: SqliteFinalizeFixture): unknown {
  return commitSqliteEncryptedBroadcast(
    fixture.database,
    { broadcast_id: fixture.broadcastId },
    FINALIZE_NOW,
    FINALIZE_AUTHORIZATION,
  );
}

const corruptions: readonly {
  readonly name: string;
  readonly mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery) => void;
}[] = [
  {
    name: "changed recipient generation",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      fixture.database
        .query("UPDATE agents SET generation = 2 WHERE agent_id = ?")
        .run(last.recipientId);
    },
  },
  {
    name: "invalid sender chain in the final batch",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      fixture.database
        .query("UPDATE e2ee_broadcast_deliveries SET sender_chain_json = '{}' WHERE claim_id = ?")
        .run(last.claimId);
    },
  },
  {
    name: "header detached from the broadcast snapshot",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      const envelope: EncryptedEnvelopeDto = {
        ...last.envelope,
        header: { ...last.envelope.header, thread_id: "wrong-thread" },
      };
      fixture.database
        .query("UPDATE e2ee_broadcast_deliveries SET envelope_json = ? WHERE claim_id = ?")
        .run(JSON.stringify(envelope), last.claimId);
    },
  },
  {
    name: "ciphertext counter detached from the payload",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      fixture.database
        .query("UPDATE e2ee_broadcast_deliveries SET ciphertext_bytes = 529 WHERE claim_id = ?")
        .run(last.claimId);
      fixture.database
        .query("UPDATE e2ee_usage SET pending_ciphertext_bytes = pending_ciphertext_bytes + 1")
        .run();
    },
  },
  {
    name: "oversized previously staged SQLite envelope",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      fixture.database
        .query("UPDATE e2ee_broadcast_deliveries SET envelope_json = ? WHERE claim_id = ?")
        .run(` ${" ".repeat(1_048_576)}${JSON.stringify(last.envelope)}`, last.claimId);
    },
  },
  {
    name: "oversized previously staged SQLite sender chain",
    mutate: (fixture: SqliteFinalizeFixture, last: FinalizeFixtureDelivery): void => {
      fixture.database
        .query("UPDATE e2ee_broadcast_deliveries SET sender_chain_json = ? WHERE claim_id = ?")
        .run(" ".repeat(1_048_577), last.claimId);
    },
  },
];

for (const corruption of corruptions) {
  test(`SQLite finalization rejects ${corruption.name} without partial delivery`, (): void => {
    withSqliteFinalizeFixture(5, (fixture: SqliteFinalizeFixture): void => {
      const last: FinalizeFixtureDelivery | undefined = fixture.deliveries[4];
      if (last === undefined) throw new Error("Final batch fixture is missing");
      corruption.mutate(fixture, last);
      const before: ReturnType<typeof readSqliteE2eeUsage> = readSqliteE2eeUsage(fixture.database);
      expect((): unknown => commit(fixture)).toThrow();
      expect(fixture.database.query("SELECT count(*) AS count FROM e2ee_messages").get()).toEqual({
        count: 0,
      });
      expect(
        fixture.database.query("SELECT state, committed_at FROM e2ee_broadcasts").get(),
      ).toEqual({ committed_at: null, state: "pending" });
      expect(readSqliteE2eeUsage(fixture.database)).toEqual(before);
      expect(
        fixture.database.query("SELECT count(*) AS count FROM e2ee_broadcast_deliveries").get(),
      ).toEqual({ count: 5 });
    });
  });
}

test("SQLite finalization commits across a batch boundary and keeps exact retries", (): void => {
  withSqliteFinalizeFixture(5, (fixture: SqliteFinalizeFixture): void => {
    expect(commit(fixture)).toMatchObject({ duplicate: false, recipient_count: 5 });
    expect(
      fixture.database.query("SELECT recipient_id FROM e2ee_messages ORDER BY sequence").all(),
    ).toEqual(
      fixture.deliveries.map(
        (delivery: FinalizeFixtureDelivery): { readonly recipient_id: string } => ({
          recipient_id: delivery.recipientId,
        }),
      ),
    );
    expect(readSqliteE2eeUsage(fixture.database)).toMatchObject({
      claimCount: 0,
      pendingBroadcastCount: 0,
      pendingCiphertextBytes: 0,
      pendingDeliveryCount: 0,
      retainedCiphertextBytes: 2640,
      retainedMessageCount: 5,
    });
    fixture.database.query("UPDATE agents SET generation = 2").run();
    expect(commit(fixture)).toMatchObject({ duplicate: true, recipient_count: 5 });
    expect(fixture.database.query("SELECT count(*) AS count FROM e2ee_messages").get()).toEqual({
      count: 5,
    });
  });
});

test("SQLite reads a payload-free snapshot and exactly 25 four-row batches for 100 recipients", (): void => {
  withSqliteFinalizeFixture(100, (fixture: SqliteFinalizeFixture): void => {
    const queries: Mock<Database["query"]> = spyOn(fixture.database, "query");
    try {
      expect(commit(fixture)).toMatchObject({ recipient_count: 100 });
      const selects: string[] = queries.mock.calls
        .map((args: Parameters<Database["query"]>): string => args[0])
        .filter((sql: string): boolean => sql.includes("FROM e2ee_broadcast_deliveries"));
      expect(selects).toHaveLength(26);
      const snapshot: string | undefined = selects[0];
      if (snapshot === undefined) throw new Error("Snapshot query is missing");
      expect(snapshot).toContain("length(CAST(envelope_json AS BLOB)) AS envelope_bytes");
      expect(snapshot).not.toContain("envelope_json,");
      for (const sql of selects) expect(sql).toContain("LIMIT ?");
      expect(fixture.database.query("SELECT count(*) AS count FROM e2ee_messages").get()).toEqual({
        count: 100,
      });
    } finally {
      queries.mockRestore();
    }
  });
});

test("a late batch failure rolls back earlier inserts and releases its scratch reservation", (): void => {
  withSqliteFinalizeFixture(5, (fixture: SqliteFinalizeFixture): void => {
    const budget: MaterializationByteBudget = new MaterializationByteBudget(8 * 1024 * 1024);
    const scope: MaterializationScope = new MaterializationScope(budget);
    const observed: number[] = [];
    const query: Database["query"] = fixture.database.query.bind(fixture.database);
    const queries: Mock<Database["query"]> = spyOn(fixture.database, "query");
    queries.mockImplementation(function observeQuery<
      Result,
      Parameters extends SQLQueryBindings | SQLQueryBindings[],
    >(sql: string): ReturnType<typeof query<Result, Parameters>> {
      if (sql.includes("INSERT INTO e2ee_messages")) observed.push(budget.reservedBytes);
      return query<Result, Parameters>(sql);
    });
    fixture.database
      .query(
        "UPDATE e2ee_broadcast_deliveries SET sender_chain_json = '{}' WHERE recipient_id = 'recipient-004'",
      )
      .run();
    try {
      expect((): unknown =>
        withMaterializationScope(scope, (): unknown => commit(fixture)),
      ).toThrow();
      expect(observed).toHaveLength(4);
      expect(
        observed.every((bytes: number): boolean => bytes > 0 && bytes <= 8 * 1024 * 1024),
      ).toBe(true);
      expect(budget.reservedBytes).toBe(0);
      expect(fixture.database.query("SELECT count(*) AS count FROM e2ee_messages").get()).toEqual({
        count: 0,
      });
    } finally {
      queries.mockRestore();
    }
  });
});

test("scratch admission rejects before fetching payloads and releases successful work before response completion", (): void => {
  withSqliteFinalizeFixture(5, (fixture: SqliteFinalizeFixture): void => {
    const denied: MaterializationScope = new MaterializationScope(new MaterializationByteBudget(1));
    const queries: Mock<Database["query"]> = spyOn(fixture.database, "query");
    try {
      expect((): unknown =>
        withMaterializationScope(denied, (): unknown => commit(fixture)),
      ).toThrow(MaterializationCapacityError);
      expect(
        queries.mock.calls.some((args: Parameters<Database["query"]>): boolean =>
          args[0].includes("json_each"),
        ),
      ).toBe(false);
    } finally {
      queries.mockRestore();
    }
    const budget: MaterializationByteBudget = new MaterializationByteBudget(8 * 1024 * 1024);
    const scope: MaterializationScope = new MaterializationScope(budget);
    expect(withMaterializationScope(scope, (): unknown => commit(fixture))).toMatchObject({
      duplicate: false,
    });
    expect(budget.reservedBytes).toBe(0);
  });
});

test("empty and incomplete snapshots preserve all-or-nothing finalization", (): void => {
  withSqliteFinalizeFixture(0, (fixture: SqliteFinalizeFixture): void => {
    expect(commit(fixture)).toMatchObject({ recipient_count: 0 });
  });
  withSqliteFinalizeFixture(5, (fixture: SqliteFinalizeFixture): void => {
    fixture.database.query("UPDATE e2ee_broadcasts SET recipient_count = 4").run();
    expect((): unknown => commit(fixture)).toThrow("delivery set is incomplete");
    fixture.database.query("UPDATE e2ee_broadcasts SET recipient_count = 5").run();
    fixture.database
      .query(`UPDATE e2ee_broadcast_deliveries SET accepted_at = NULL,
      ciphertext_bytes = NULL, envelope_json = NULL, sender_chain_json = NULL
      WHERE recipient_id = 'recipient-004'`)
      .run();
    expect((): unknown => commit(fixture)).toThrow();
    expect(fixture.database.query("SELECT count(*) AS count FROM e2ee_messages").get()).toEqual({
      count: 0,
    });
  });
});
