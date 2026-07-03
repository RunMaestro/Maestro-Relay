import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutStallDetector, type RoomStallInfo } from '../providers/discord/roomStall';

/**
 * Stall detector (P2 #59). The behaviour under test is the per-addressee
 * tracking: a message that `@`-mentions two bots arms one expectation per
 * addressee, and arming the second must NOT cancel the first (the old
 * per-channel keying dropped the first bot's stall). A real follow-up message
 * clears every expectation; the arming message itself never does.
 */

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('multi-mention arms an independent stall per addressee (no sibling cancel)', async () => {
  const fired: string[] = [];
  const det = new TimeoutStallDetector({
    timeoutMs: 10,
    onStall: (i: RoomStallInfo) => {
      fired.push(i.addressee);
    },
  });

  // One message mentioning both bots: each listener arms its own expectation.
  det.expect('chan', 'Ada', 'msg1');
  det.expect('chan', 'Ben', 'msg1');

  await delay(80);
  det.clear();

  fired.sort();
  assert.deepEqual(fired, ['Ada', 'Ben'], 'both addressees stall — first is not lost');
});

test('a reply clears only its own addressee — a co-mentioned stalled bot still fires', async () => {
  const fired: string[] = [];
  const det = new TimeoutStallDetector({
    timeoutMs: 20,
    onStall: (i: RoomStallInfo) => {
      fired.push(i.addressee);
    },
  });

  // One message mentions both Ada and Ben; each listener arms its own watch.
  det.expect('chan', 'Ada', 'msg1');
  det.expect('chan', 'Ben', 'msg1');

  // The arming message (peer bots observe it too) must not clear its own arms,
  // even when attributed to a co-mentioned addressee.
  det.observe('chan', 'msg1', 'Ada');
  // Ada replies (a new id, authored by Ada) → clears ONLY Ada's watch. Ben is
  // genuinely stalled and its timer must survive so its stall still fires.
  det.observe('chan', 'msg2', 'Ada');

  await delay(70);
  det.clear();

  assert.deepEqual(fired, ['Ben'], "Ben's stall still fires after Ada replies");
});

test('a human follow-up (no addressee) clears nothing — the addressed bot still stalls', async () => {
  const fired: string[] = [];
  const det = new TimeoutStallDetector({
    timeoutMs: 20,
    onStall: (i: RoomStallInfo) => {
      fired.push(i.addressee);
    },
  });

  det.expect('chan', 'Ada', 'msg1');
  // A human message carries no participant handle → satisfies no bot's reply.
  det.observe('chan', 'msg2');

  await delay(70);
  det.clear();

  assert.deepEqual(fired, ['Ada'], 'a human message does not absolve an addressed bot');
});

test('re-arming one addressee leaves a co-mentioned sibling intact', async () => {
  const fired: string[] = [];
  const det = new TimeoutStallDetector({
    timeoutMs: 10,
    onStall: (i: RoomStallInfo) => {
      fired.push(i.addressee);
    },
  });

  det.expect('chan', 'Ada', 'msg1');
  det.expect('chan', 'Ben', 'msg1');
  // Re-arm Ada (e.g. a later mention) — Ben's watch must survive.
  det.expect('chan', 'Ada', 'msg3');

  await delay(80);
  det.clear();

  fired.sort();
  assert.deepEqual(fired, ['Ada', 'Ben']);
});
