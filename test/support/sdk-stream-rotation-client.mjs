import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

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
  await boundedWait(client.connect(transport));
  const sender = await boundedWait(
    client.callTool({
      arguments: { agent_id: "rotation-sender", display_name: "Rotation Sender" },
      name: "register_agent",
    }),
  );
  const receiver = await boundedWait(
    client.callTool({
      arguments: { agent_id: "rotation-receiver", display_name: "Rotation Receiver" },
      name: "register_agent",
    }),
  );
  if (sender.isError === true || receiver.isError === true) {
    throw new Error("SDK rotation agents could not be registered");
  }
  const inboxUri = "murmur://inbox/rotation-receiver";
  let resolveNotification;
  const notificationReceived = new Promise((resolve) => {
    resolveNotification = resolve;
  });
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    if (notification.params.uri !== inboxUri || resolveNotification === undefined) return;
    resolveNotification(notification.params.uri);
    resolveNotification = undefined;
  });
  await boundedWait(client.subscribeResource({ uri: inboxUri }));
  if (getRequests !== 1) {
    throw new Error("SDK rotation stream changed before the inbox subscription was established");
  }
  await boundedWait(waitForGetRequests(2));
  const sent = await boundedWait(
    client.callTool({
      arguments: {
        content: "notification after SDK stream rotation",
        idempotency_key: "sdk-rotation-notification",
        recipient_id: "rotation-receiver",
        sender_id: "rotation-sender",
      },
      name: "send_message",
    }),
  );
  if (sent.isError === true) throw new Error("SDK rotation message could not be sent");
  const notificationUri = await boundedWait(notificationReceived);
  const inbox = await boundedWait(client.readResource({ uri: inboxUri }));
  const content = inbox.contents[0];
  if (content === undefined || !("text" in content)) {
    throw new Error("SDK rotation inbox did not contain JSON text");
  }
  const parsedInbox = JSON.parse(content.text);
  if (!Array.isArray(parsedInbox.messages)) {
    throw new Error("SDK rotation inbox did not contain a messages array");
  }
  const tools = await boundedWait(client.listTools());
  console.log(
    JSON.stringify({
      get_requests: getRequests,
      inbox_message_count: parsedInbox.messages.length,
      notification_received: notificationUri === inboxUri,
      session_retained: transport.sessionId !== undefined,
      tool_count: tools.tools.length,
    }),
  );
} catch (_error) {
  console.error("SDK rotation verification failed");
  process.exitCode = 1;
} finally {
  try {
    await boundedWait(client.close());
  } catch (_error) {
    console.error("SDK rotation client cleanup failed");
    process.exitCode = 1;
  }
}
