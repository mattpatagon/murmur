import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.argv[2];
const token = process.argv[3];
if (endpoint === undefined || token === undefined) {
  throw new Error("The SDK rotation verifier requires an endpoint and token");
}

let getRequests = 0;
const getWaiters = [];
const observedFetch = async (input, init) => {
  if (init !== undefined && init.method === "GET") {
    getRequests += 1;
    getWaiters.splice(0).forEach((wake) => {
      wake();
    });
  }
  return await fetch(input, init);
};
const waitForGetRequests = async (count) => {
  while (getRequests < count) {
    await new Promise((resolve) => getWaiters.push(resolve));
  }
};
const boundedWait = async (operation) => {
  let timeout;
  const expired = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("SDK rotation verification timed out")), 5_000);
    timeout.unref();
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    clearTimeout(timeout);
  }
};

const client = new Client({ name: "rotation-client", version: "1.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  fetch: observedFetch,
  reconnectionOptions: {
    initialReconnectionDelay: 0,
    maxReconnectionDelay: 0,
    maxRetries: 2,
    reconnectionDelayGrowFactor: 1,
  },
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Murmur-Branch": "feature/http-context",
      "X-Murmur-Client": "codex",
      "X-Murmur-Repository": "mattpatagon/murmur",
    },
  },
});

try {
  await client.connect(transport);
  await boundedWait(waitForGetRequests(2));
  const tools = await client.listTools();
  console.log(
    JSON.stringify({
      get_requests: getRequests,
      session_retained: transport.sessionId !== undefined,
      tool_count: tools.tools.length,
    }),
  );
} catch (_error) {
  console.error("SDK rotation verification failed");
  process.exitCode = 1;
} finally {
  await client.close();
}
