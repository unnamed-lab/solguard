import {
  CommitmentLevel,
  type SubscribeRequest,
} from "@triton-one/yellowstone-grpc";

/**
 * Subscribe-request builders (FR-1, FR-2).
 *
 * Slots: `filterByCommitment: false` so we receive the SAME slot at
 * processed → confirmed → finalized and can measure the transitions that
 * feed the congestion oracle and answer README Q1.
 *
 * Transactions: filtered to our own signatures so the lifecycle tracker can
 * confirm landing from the stream (stream-primary confirmation, FR-16).
 */

/** Slot updates across ALL commitment levels. */
export function slotSubscribeRequest(fromSlot?: bigint): SubscribeRequest {
  const req: SubscribeRequest = {
    accounts: {},
    slots: {
      // single named filter; commitment NOT filtered so we see every transition
      all: { filterByCommitment: false },
    },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };
  if (fromSlot !== undefined) {
    // resume replay from the last processed slot (FR-3)
    req.fromSlot = fromSlot.toString();
  }
  return req;
}

/**
 * Transaction updates filtered to a set of signatures we care about.
 * Yellowstone matches by account inclusion, so for our own bundles we track
 * by accountInclude (the fee payer / signer); the tracker then matches the
 * exact signatures it submitted.
 */
export function txSubscribeRequest(accountIncludes: string[]): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {
      mine: {
        vote: false,
        failed: false,
        accountInclude: accountIncludes,
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };
}

/**
 * Combined slot + (optional) transaction subscription in ONE request.
 *
 * A Yellowstone `SubscribeRequest` REPLACES the entire subscription state —
 * it is not merged with prior writes. Sending the slot request and then the
 * tx request as two separate writes makes the second (with `slots: {}`) clobber
 * the slot subscription, freezing slot updates. Always subscribe to everything
 * we want in a single request.
 */
export function combinedSubscribeRequest(
  fromSlot?: bigint,
  accountIncludes: string[] = [],
): SubscribeRequest {
  const req = slotSubscribeRequest(fromSlot);
  if (accountIncludes.length > 0) {
    req.transactions = {
      mine: {
        vote: false,
        failed: false,
        accountInclude: accountIncludes,
        accountExclude: [],
        accountRequired: [],
      },
    };
  }
  return req;
}

/** A bare ping request used to reply to server keepalives (FR-4). */
export function pingRequest(): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: { id: 1 },
  };
}
