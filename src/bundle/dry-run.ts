/**
 * Bundle dry-run harness — validates Phase 2 pipeline end-to-end without
 * submitting to Jito. Fetches live tip floor, computes tip, fetches tip
 * accounts + blockhash, builds + signs a bundle, then logs everything.
 *
 * Run: pnpm tsx src/bundle/dry-run.ts
 */
import { SystemProgram } from "@solana/web3.js";
import { wallet } from "../solana/connection.js";
import { jitoClient } from "../jito/client.js";
import { tipFloorService } from "../tips/tipFloor.js";
import { computeTip, selectPercentile } from "../tips/model.js";
import { buildBundle, fetchConfirmedBlockhash } from "./builder.js";
import { logger } from "../util/log.js";

const log = logger("dry-run");

async function main() {
  log.info("=== SolGuard Bundle Dry-Run ===");

  // 1. fetch live tip floor
  const tf = await tipFloorService().get();
  log.info("tip_floor fetched", { p25: tf.p25, p50: tf.p50, p75: tf.p75, p95: tf.p95, p99: tf.p99, ema: tf.ema });

  // 2. compute tip from model (normal urgency, default congestion)
  const urgency = "normal";
  const percentileKey = selectPercentile(1.0, urgency);
  const tip = computeTip({ tipFloor: tf, congestionMultiplier: 1.0, urgency });
  log.info("tip computed", { urgency, percentileKey, lamports: tip.lamports, clamped: tip.clamped });

  // 3. fetch tip accounts from Jito block engine
  const tipAccounts = await jitoClient().getTipAccounts();
  const chosenTip = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
  log.info("tip accounts", { count: tipAccounts.length, chosen: chosenTip });

  // 4. fetch confirmed blockhash (FR-12) — reused for the bundle below so all
  //    txs share ONE blockhash (FR-11) instead of the builder fetching its own.
  const bh = await fetchConfirmedBlockhash();
  log.info("blockhash fetched", {
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    slot: bh.fetchedAtSlot,
  });

  // 5. build a dummy bundle: simple SOL transfer to self (no-op bundle)
  const payer = wallet();
  const dummyIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  });

  const built = await buildBundle({
    transactions: [[dummyIx]],
    tipLamports: tip.lamports,
    tipAccount: chosenTip,
    blockhash: bh,
  });

  log.info("bundle built successfully", {
    txCount: built.encodedTxs.length,
    signatures: built.signatures,
    tipLamports: built.tipLamports,
    tipAccount: built.tipAccount,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    fetchedAtSlot: built.fetchedAtSlot,
  });

  // 6. verify signatures are valid base64 (non-empty)
  for (let i = 0; i < built.signatures.length; i++) {
    const sigLen = built.signatures[i]!.length;
    if (sigLen < 10) throw new Error(`signature ${i} too short: ${sigLen}`);
  }
  log.info("all signatures valid");

  log.info("=== Dry-Run Complete ===");
  log.info("Next step: pnpm tsx src/bundle/submit.ts to actually submit");
}

main().catch((err) => {
  log.error("dry-run failed", { err: String(err) });
  process.exit(1);
});
