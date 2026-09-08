import { expect, test } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { e2eeProxyTools } from "../src/e2ee/proxy-tools.js";

test("encrypted inbox reads advertise their automatic acknowledgement mutation", (): void => {
  const tools: readonly Tool[] = e2eeProxyTools();
  for (const name of ["get_messages", "wait_for_messages"]) {
    const tool: Tool | undefined = tools.find(
      (candidate: Tool): boolean => candidate.name === name,
    );
    if (tool === undefined || tool.annotations === undefined || tool.description === undefined) {
      throw new Error(`Missing encrypted proxy tool contract for ${name}`);
    }
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.description).toContain("mark every returned message read remotely");
  }
});
