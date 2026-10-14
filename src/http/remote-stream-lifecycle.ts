import type { RequestObservation } from "../observability/request-observation.js";
import type { TimeSource } from "./http-capacity.js";
import type { RemoteSession, StandaloneStream } from "./remote-session.js";
import { responseWithDeadline, responseWithFinish, trackedResponse } from "./response-lifecycle.js";

const ROTATION_JITTER_DIVISOR: number = 10;

export function streamRotationDelay(sessionId: string, maximumLifetimeMs: number): number {
  const jitterWindowMs: number = Math.floor(maximumLifetimeMs / ROTATION_JITTER_DIVISOR);
  if (jitterWindowMs === 0) return maximumLifetimeMs;
  let fingerprint: number = 0;
  for (const character of sessionId) {
    fingerprint = (fingerprint * 33 + character.charCodeAt(0)) % (jitterWindowMs + 1);
  }
  return maximumLifetimeMs - fingerprint;
}

function isStandaloneEventStream(response: Response, standalone: boolean): boolean {
  if (!standalone || response.body === null || response.status !== 200) return false;
  const contentType: string | null = response.headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().startsWith("text/event-stream");
}

export function trackSessionResponse(
  response: Response,
  session: RemoteSession,
  sessionId: string,
  standalone: boolean,
  maximumLifetimeMs: number,
  time: TimeSource,
  observation: RequestObservation,
): Response {
  const tracked: Response = trackedResponse(response, session);
  if (!isStandaloneEventStream(response, standalone)) return tracked;
  const stream: StandaloneStream = { openedAt: time.now() };
  session.standaloneStream = stream;
  const rotating: Response = responseWithDeadline(
    tracked,
    streamRotationDelay(sessionId, maximumLifetimeMs),
    time,
    (): void => {
      if (session.standaloneStream !== stream) return;
      observation.recordStreamRotation();
      session.lastSeenAt = time.now();
      session.transport.closeStandaloneSSEStream();
    },
  );
  return responseWithFinish(rotating, (): void => {
    if (session.standaloneStream === stream) session.standaloneStream = undefined;
  });
}
