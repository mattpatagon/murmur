import type { HttpCapacityController, TimeSource } from "./http-capacity.js";
import type { HttpServerConfig } from "./http-config.js";
import { OwnerStreamAdmissionController } from "./owner-stream-admission.js";
import type { RemoteSession } from "./remote-session.js";
import { SessionAdmissionController } from "./session-admission.js";
import type { RemoteSessionInvalidator } from "./session-invalidation.js";

export type OwnerAdmissions = {
  readonly expireIdleSessions: (now: number) => Promise<void>;
  readonly sessions: SessionAdmissionController;
  readonly streams: OwnerStreamAdmissionController;
};

export function createOwnerAdmissions(
  capacity: HttpCapacityController,
  config: HttpServerConfig,
  sessions: Map<string, RemoteSession>,
  time: TimeSource,
  invalidator: RemoteSessionInvalidator,
): OwnerAdmissions {
  return {
    expireIdleSessions: async (now: number): Promise<void> => {
      const expired: [string, RemoteSession][] = Array.from(sessions.entries()).filter(
        (entry: [string, RemoteSession]): boolean =>
          entry[1].activeResponses === 0 && now - entry[1].lastSeenAt >= config.sessionIdleMs,
      );
      capacity.pruneRateWindows();
      await invalidator.close(expired, "Murmur idle-session shutdown failed");
    },
    sessions: new SessionAdmissionController(sessions, config, time),
    streams: new OwnerStreamAdmissionController(capacity, sessions, config, time),
  };
}
