import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { FOUNDING_TENANT_ID } from "../src/domain/value-objects.js";
import {
  credentialAdmissionKey,
  generateTokenSecret,
  type HostedTokenSecret,
} from "../src/hosted/token-secret.js";
import {
  type StorageBudgetFixture,
  storageBudgetTestsEnabled,
  withStorageBudgetFixture,
} from "./support/hosted-storage-budget.js";

const KeysSchema: z.ZodType<{ readonly admission_key: string }[]> = z.array(
  z.strictObject({ admission_key: z.string().regex(/^[a-f0-9]{64}$/u) }),
);

test.skipIf(!storageBudgetTestsEnabled)(
  "owner admission query returns only double hashes of live founding credentials",
  async (): Promise<void> => {
    await withStorageBudgetFixture(async (fixture: StorageBudgetFixture): Promise<void> => {
      const live: HostedTokenSecret = generateTokenSecret("mur");
      const expired: HostedTokenSecret = generateTokenSecret("mur");
      const revoked: HostedTokenSecret = generateTokenSecret("mur");
      const ordinary: HostedTokenSecret = generateTokenSecret("mur");
      const tokenIds: string[] = [];
      try {
        for (const item of [
          { token: live, tenant: FOUNDING_TENANT_ID, expired: false, revoked: false },
          { token: expired, tenant: FOUNDING_TENANT_ID, expired: true, revoked: false },
          { token: revoked, tenant: FOUNDING_TENANT_ID, expired: false, revoked: true },
          { token: ordinary, tenant: fixture.firstTenant, expired: false, revoked: false },
        ]) {
          const id: string = randomUUID();
          await fixture.admin`
          INSERT INTO murmur.access_tokens(token_id, tenant_id, key_id, secret_hash, token_role, name, created_at, expires_at, revoked_at)
          VALUES (${id}::uuid, ${item.tenant}::uuid, ${item.token.keyId}, ${item.token.hash}, 'agent', 'Owner admission regression',
            statement_timestamp() - interval '2 hours',
            CASE WHEN ${item.expired} THEN statement_timestamp() - interval '1 hour' ELSE NULL END,
            CASE WHEN ${item.revoked} THEN statement_timestamp() ELSE NULL END)
        `;
          tokenIds.push(id);
        }
        const raw: unknown =
          await fixture.app`SELECT admission_key FROM murmur.founding_owner_admission_keys()`;
        const keys: string[] = KeysSchema.parse(raw).map(
          (row: { readonly admission_key: string }): string => row.admission_key,
        );
        expect(keys).toContain(credentialAdmissionKey(live.secret));
        expect(keys).not.toContain(live.hash.toString("hex"));
        expect(keys).not.toContain(credentialAdmissionKey(expired.secret));
        expect(keys).not.toContain(credentialAdmissionKey(revoked.secret));
        expect(keys).not.toContain(credentialAdmissionKey(ordinary.secret));
        expect(keys.length).toBeLessThanOrEqual(1_000);
        const liveTokenId: string | undefined = tokenIds[0];
        if (liveTokenId === undefined) throw new Error("Owner admission test token is missing");
        await fixture.admin`UPDATE murmur.access_tokens SET revoked_at = statement_timestamp() WHERE token_id = ${liveTokenId}::uuid`;
        const after: unknown =
          await fixture.app`SELECT admission_key FROM murmur.founding_owner_admission_keys()`;
        expect(
          KeysSchema.parse(after).map(
            (row: { readonly admission_key: string }): string => row.admission_key,
          ),
        ).not.toContain(credentialAdmissionKey(live.secret));
        const hiddenRows: unknown = await fixture.app`SELECT secret_hash FROM murmur.access_tokens`;
        expect(
          z.array(z.strictObject({ secret_hash: z.instanceof(Buffer) })).parse(hiddenRows),
        ).toEqual([]);
        const privileges: unknown = await fixture.admin`
        SELECT has_function_privilege('anon', 'murmur.founding_owner_admission_keys()', 'EXECUTE') AS anonymous,
          has_function_privilege('authenticated', 'murmur.founding_owner_admission_keys()', 'EXECUTE') AS authenticated,
          has_function_privilege('murmur_app', 'murmur.founding_owner_admission_keys()', 'EXECUTE') AS runtime
      `;
        expect(
          z
            .array(
              z.strictObject({
                anonymous: z.boolean(),
                authenticated: z.boolean(),
                runtime: z.boolean(),
              }),
            )
            .parse(privileges),
        ).toEqual([{ anonymous: false, authenticated: false, runtime: true }]);
      } finally {
        await fixture.admin`DELETE FROM murmur.access_tokens WHERE token_id = ANY(${fixture.admin.array(tokenIds)}::uuid[])`;
      }
    });
  },
);
