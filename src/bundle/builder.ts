import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Blockhash,
} from "@solana/web3.js";

import bs58 from "bs58";

import { connection, wallet } from "../solana/connection.js";
import { jitoClient } from "../jito/client.js";
import { logger } from "../util/log.js";

const log = logger("builder");

const MAX_TXS_PER_BUNDLE = 5; // Jito hard limit (plan §4)

export interface BlockhashInfo {
  blockhash: Blockhash;
  lastValidBlockHeight: number;
  /** the slot the blockhash was fetched at (for age/expiry diagnostics) */
  fetchedAtSlot: number;
}

export interface BundlePlan {
  /** instructions for each transaction in the bundle (tip is appended for you) */
  transactions: TransactionInstruction[][];
  /** tip amount in lamports — comes from the tip model (never hardcoded) */
  tipLamports: number;
  /** optional explicit tip account; otherwise a random Jito tip account is used */
  tipAccount?: string;
  /**
   * optional blockhash override. Used by the fault injector to force expiry.
   * Normal path fetches a fresh `confirmed` blockhash (FR-12).
   */
  blockhash?: BlockhashInfo;
}

export interface BuiltBundle {
  encodedTxs: string[]; // base64-encoded signed VersionedTransactions
  signatures: string[];
  tipAccount: string;
  tipLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
  fetchedAtSlot: number;
}

// tip accounts change rarely; cache them per process
let _tipAccounts: string[] | undefined;
async function getTipAccounts(): Promise<string[]> {
  if (_tipAccounts && _tipAccounts.length > 0) return _tipAccounts;
  _tipAccounts = await jitoClient().getTipAccounts();
  return _tipAccounts;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Fetch a blockhash at `confirmed` commitment (never `finalized`) — FR-12. */
export async function fetchConfirmedBlockhash(): Promise<BlockhashInfo> {
  const conn = connection();
  const [{ blockhash, lastValidBlockHeight }, slot] = await Promise.all([
    conn.getLatestBlockhash("confirmed"),
    conn.getSlot("confirmed"),
  ]);
  return { blockhash, lastValidBlockHeight, fetchedAtSlot: slot };
}

/**
 * Build a signed bundle (plan §5.5):
 *  - ≤5 versioned transactions
 *  - tip transfer appended to the LAST transaction (FR-11)
 *  - all transactions share ONE recent blockhash (FR-11)
 *  - tip account chosen at random to avoid write-lock contention (FR-10)
 */
export async function buildBundle(plan: BundlePlan): Promise<BuiltBundle> {
  if (plan.transactions.length === 0) {
    throw new Error("bundle must contain at least one transaction");
  }
  if (plan.transactions.length > MAX_TXS_PER_BUNDLE) {
    throw new Error(`bundle exceeds ${MAX_TXS_PER_BUNDLE} transactions`);
  }

  const payer = wallet();
  const bh = plan.blockhash ?? (await fetchConfirmedBlockhash());
  const tipAccount = plan.tipAccount ?? pickRandom(await getTipAccounts());
  const tipPubkey = new PublicKey(tipAccount);

  // deep-copy instruction groups so we can append the tip to the last one
  const groups = plan.transactions.map((ixs) => [...ixs]);
  const lastGroup = groups[groups.length - 1]!;
  lastGroup.push(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipPubkey,
      lamports: plan.tipLamports, // sourced from the tip model — not a literal
    }),
  );

  const encodedTxs: string[] = [];
  const signatures: string[] = [];

  for (const ixs of groups) {
    const msg = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);

    const sig = tx.signatures[0];
    if (!sig) throw new Error("transaction missing signature after signing");
    signatures.push(bs58Encode(sig));
    encodedTxs.push(Buffer.from(tx.serialize()).toString("base64"));
  }

  log.info("bundle built", {
    txCount: encodedTxs.length,
    tipLamports: plan.tipLamports,
    tipAccount,
    blockhash: bh.blockhash,
  });

  return {
    encodedTxs,
    signatures,
    tipAccount,
    tipLamports: plan.tipLamports,
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    fetchedAtSlot: bh.fetchedAtSlot,
  };
}

function bs58Encode(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}
