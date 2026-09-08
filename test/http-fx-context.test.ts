import { expect, test } from "bun:test";

import {
  branchFromRequest,
  clientFromRequest,
  repositoryFromRequest,
} from "../src/http/http-request.js";
import type { AgentClient, BranchName, RepositoryName } from "../src/domain/value-objects.js";

test("accepts fx HTTP provenance at the request boundary", (): void => {
  const request: Request = new Request("https://api.example.test/mcp", {
    headers: {
      "X-Murmur-Branch": "feature/fx-native",
      "X-Murmur-Client": "FX",
      "X-Murmur-Repository": "mattpatagon/murmur",
    },
  });
  const client: AgentClient | null = clientFromRequest(request);
  const repository: RepositoryName | null = repositoryFromRequest(request);
  const branch: BranchName | null = branchFromRequest(request);
  if (client === null || repository === null || branch === null) {
    throw new Error("Expected complete fx request context");
  }
  expect(client.value).toBe("fx");
  expect(repository.value).toBe("mattpatagon/murmur");
  expect(branch.value).toBe("feature/fx-native");
});
