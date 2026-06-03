import { jitoClient } from "../jito/client.js";
import { logger } from "../util/log.js";
import type { BuiltBundle } from "./builder.js";

const log = logger("submitter");

export interface SubmitResult {
  bundleId: string;
  signatures: string[];
  tipLamports: number;
  tipAccount: string;
  submittedAt: number;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Bundle Submitter (plan §5.5). Sends a built bundle to the regional Jito
 * block-engine endpoint (the JitoClient handles 0-2 fallbacks). Returns the
 * bundle_id; landing is confirmed downstream from the STREAM, not from here
 * (FR-16) — the bundle-status methods are reconciliation only (FR-17).
 */
export async function submitBundle(built: BuiltBundle): Promise<SubmitResult> {
  const bundleId = await jitoClient().sendBundle(built.encodedTxs, "base64");
  const submittedAt = Date.now();
  log.info("bundle submitted", {
    bundleId,
    signatures: built.signatures,
    tipLamports: built.tipLamports,
  });
  return {
    bundleId,
    signatures: built.signatures,
    tipLamports: built.tipLamports,
    tipAccount: built.tipAccount,
    submittedAt,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
  };
}
