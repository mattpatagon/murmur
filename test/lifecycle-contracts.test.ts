import { expect, test } from "bun:test";

import {
  InboxOutputSchema,
  MessageDtoSchema,
  toMessageDto,
  type InboxOutput,
  type MessageDto,
} from "../src/domain/contracts.js";
import { toHistoryMessageDto, type HistoryMessageDto } from "../src/domain/history-contracts.js";
import type { SendMessageResult } from "../src/domain/models.js";
import { type StoreFixture, baseMessageCommand, withFixture } from "./support/store-fixture.js";

test("legacy message and inbox wire keys remain frozen while history exposes generations", (): void => {
  withFixture((fixture: StoreFixture): void => {
    const sent: SendMessageResult = fixture.store.sendMessage(baseMessageCommand());
    const legacy: MessageDto = toMessageDto(sent.message);
    expect(Object.keys(legacy).sort()).toEqual([
      "content",
      "context",
      "created_at",
      "expires_at",
      "message_id",
      "read_at",
      "recipient_id",
      "sender_id",
      "sequence",
      "thread_id",
    ]);
    expect(MessageDtoSchema.parse(legacy)).toEqual(legacy);
    expect((): unknown => MessageDtoSchema.parse({ ...legacy, sender_generation: 1 })).toThrow();
    const inbox: InboxOutput = {
      agent_id: "bob",
      inbox_version: sent.message.sequence.value,
      messages: [legacy],
    };
    expect(InboxOutputSchema.parse(inbox)).toEqual(inbox);
    expect((): unknown => InboxOutputSchema.parse({ ...inbox, generation: 1 })).toThrow();
    const history: HistoryMessageDto = toHistoryMessageDto(sent.message);
    expect(history.sender_generation).toBe(1);
    expect(history.recipient_generation).toBe(1);
  });
});
