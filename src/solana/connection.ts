import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";

/**
 * Shared Solana RPC connection. Defaults to `confirmed` commitment, which is
 * what we use for time-sensitive work (blockhash, leader schedule). We never
 * default to `finalized` for the hot path (FR-12).
 */
let _conn: Connection | undefined;
export function connection(): Connection {
  if (!_conn) {
    _conn = new Connection(config.rpc.http, {
      commitment: "confirmed",
      wsEndpoint: config.rpc.ws || undefined,
    });
  }
  return _conn;
}

/**
 * Load the hot wallet from the base58 secret key (NFR-7: minimal funds).
 * Throws only when actually needed (Phase 2+), so streaming/observability
 * phases can run without a wallet.
 */
let _wallet: Keypair | undefined;
export function wallet(): Keypair {
  if (_wallet) return _wallet;
  if (!config.wallet.secretKey) {
    throw new Error("WALLET_SECRET_KEY is not set — required for bundle submission (Phase 2+).");
  }
  _wallet = Keypair.fromSecretKey(bs58.decode(config.wallet.secretKey));
  return _wallet;
}

/** Best-effort wallet pubkey for stream filtering; returns undefined if unset. */
export function walletPubkey(): string | undefined {
  try {
    return wallet().publicKey.toBase58();
  } catch {
    return undefined;
  }
}
