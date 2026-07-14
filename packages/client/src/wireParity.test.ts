import { describe, expect, it } from 'vitest';
import type {
  ChatChannel as ClientChatChannel,
  MultiplayerChatMessage,
  MultiplayerPing,
  PingAnchor as ClientPingAnchor,
  PingKind as ClientPingKind,
} from './multiplayer';
// The client deliberately has NO runtime dependency on the server package — this
// TYPE-ONLY relative import exists purely so `tsc` fails the gate when the two
// hand-written copies of the wire contract drift apart (they duplicated silently
// before). Nothing from the server lands in the client bundle.
import type {
  ChatChannel as ServerChatChannel,
  ChatMessage as ServerChatMessage,
  Ping as ServerPing,
  PingAnchor as ServerPingAnchor,
  PingKind as ServerPingKind,
} from '../../server/src/protocol';

/** `true` only when A and B are assignable BOTH ways (structurally identical). */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time assertions: a drifted union/field turns these `true`s into type
// errors, so `pnpm run typecheck` (and this test's transform) catches the drift.
const pingKindsMatch: Mutual<ClientPingKind, ServerPingKind> = true;
const pingAnchorsMatch: Mutual<ClientPingAnchor, ServerPingAnchor> = true;
const pingsMatch: Mutual<MultiplayerPing, ServerPing> = true;
const chatChannelsMatch: Mutual<ClientChatChannel, ServerChatChannel> = true;
const chatMessagesMatch: Mutual<MultiplayerChatMessage, ServerChatMessage> = true;

describe('wire parity — client mirrors of the server protocol', () => {
  it('every mirrored wire type is mutually assignable with the server original', () => {
    expect(pingKindsMatch).toBe(true);
    expect(pingAnchorsMatch).toBe(true);
    expect(pingsMatch).toBe(true);
    expect(chatChannelsMatch).toBe(true);
    expect(chatMessagesMatch).toBe(true);
  });
});
