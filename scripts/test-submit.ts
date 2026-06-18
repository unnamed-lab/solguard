/**
 * Live pipeline smoke test.
 *
 * Checks wallet balance, then submits via SolGuard — exercising the full stack:
 *   Yellowstone gRPC → tip pricing → Jito bundle → AI retry agent
 *
 * Usage:
 *   pnpm test:submit            # simple SOL transfer test
 *   pnpm test:submit -- --swap  # Jupiter token swap test
 */
import "dotenv/config";
import {
  Connection,
  Keypair,
  SystemProgram,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { SolGuard } from "../src/sdk/solguard.js";

const RPC_URL = process.env.RPC_HTTP_URL;
const SECRET_KEY_B58 = process.env.WALLET_SECRET_KEY;
const CLUSTER = process.env.SOLANA_CLUSTER ?? "mainnet-beta";

// Token the user wants to buy
const TOKEN_MINT = "3ifTB4CtomDdMtMPNVaVZ6ViT8oUXenk9qZbrY4KMory";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";

if (!RPC_URL) throw new Error("RPC_HTTP_URL is not set in .env");
if (!SECRET_KEY_B58) throw new Error("WALLET_SECRET_KEY is not set in .env");

const doSwap = process.argv.includes("--swap");

function sol(lamports: number) {
  return `${(lamports / 1e9).toFixed(6)} SOL`;
}

// ── Jupiter helpers ──────────────────────────────────────────────────────────
async function jupiterQuote(inputMint: string, outputMint: string, amountLamports: number) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=100`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
  return res.json();
}

async function jupiterSwapTx(quoteResponse: unknown, walletPubkey: string): Promise<VersionedTransaction> {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
      // Let SolGuard handle the Jito tip — don't add the Jupiter platform fee as tip
      prioritizationFeeLamports: { jitoTipLamports: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Jupiter swap failed: HTTP ${res.status}`);
  const { swapTransaction } = await res.json() as { swapTransaction: string };
  const buf = Buffer.from(swapTransaction, "base64");
  return VersionedTransaction.deserialize(buf);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC_URL!, "confirmed");

  let secretKey: Uint8Array;
  try {
    secretKey = bs58.decode(SECRET_KEY_B58!);
  } catch {
    secretKey = Uint8Array.from(JSON.parse(SECRET_KEY_B58!));
  }

  const wallet = Keypair.fromSecretKey(secretKey);
  console.log("\n=== SolGuard Live Test ===");
  console.log(`Cluster  : ${CLUSTER}`);
  console.log(`Wallet   : ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance  : ${sol(balance)}`);

  if (balance < 100_000) {
    console.error("Balance too low to cover fees. Fund the wallet first.");
    process.exit(1);
  }

  // ── Build transaction ──────────────────────────────────────────────────────
  let txInput: VersionedTransaction | Parameters<typeof SystemProgram.transfer>[0] extends infer P ? P : never;
  let description: string;

  if (doSwap) {
    // Jupiter swap: SOL → token
    const SWAP_AMOUNT = 5_000_000; // 0.005 SOL in lamports
    console.log(`\nFetching Jupiter quote: ${sol(SWAP_AMOUNT)} SOL → ${TOKEN_MINT}`);
    const quote = await jupiterQuote(WSOL_MINT, TOKEN_MINT, SWAP_AMOUNT);
    console.log(`Quote: ~${Number(quote.outAmount)} tokens out (slippage 1%)`);
    const swapTx = await jupiterSwapTx(quote, wallet.publicKey.toBase58());
    txInput = swapTx as any;
    description = `Jupiter swap: ${sol(SWAP_AMOUNT)} SOL → ${TOKEN_MINT}`;
  } else {
    // Simple SOL transfer — cheapest way to exercise the full bundle pipeline
    const TRANSFER_LAMPORTS = 5_000;
    const recipient = new PublicKey(TOKEN_MINT); // send a nominal amount to the mint pubkey
    txInput = [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: recipient,
        lamports: TRANSFER_LAMPORTS,
      }),
    ] as any;
    description = `${sol(TRANSFER_LAMPORTS)} SOL transfer → ${TOKEN_MINT}`;
  }

  console.log(`\nSubmitting: ${description}`);
  console.log("(pipeline: stream connect → tip model → Jito bundle → AI retry)\n");

  // Use at least p75-level tip for reliable mainnet inclusion
  // p75 ≈ 9,747 lamports from live floor; we set 20,000 as a safe minimum
  const COMPETITIVE_TIP = 20_000;

  const guard = new SolGuard({
    wallet,
    connection,
    submit: true,
    confirmTimeoutMs: 45_000, // 45s confirmation window
  });

  try {
    await guard.start();
    const result = await guard.submit(txInput as any, {
      urgency: "high",
      customTipLamports: COMPETITIVE_TIP,
    });

    console.log("\n=== Result ===");
    if (result.landed) {
      console.log(`✓  LANDED`);
      console.log(`   Bundle  : ${result.bundleId}`);
      console.log(`   Sig     : ${result.signature}`);
      console.log(`   Slot    : ${result.slot}`);
      console.log(`   Explorer: https://solscan.io/tx/${result.signature}`);
    } else {
      console.log(`✗  DID NOT LAND`);
      console.log(`   Bundle  : ${result.bundleId}`);
      console.log(`   Error   : ${result.error}`);
    }

    const lc = result.lifecycle;
    if (lc) {
      console.log("\n=== Lifecycle ===");
      for (const [stage, stamp] of Object.entries(lc.stages)) {
        if (stamp) console.log(`   ${stage.padEnd(12)}: slot ${stamp.slot}  ${stamp.ts}`);
      }
      if (Object.keys(lc.deltas_ms).length) {
        console.log("\n=== Timing Deltas ===");
        for (const [k, v] of Object.entries(lc.deltas_ms)) {
          if (v != null) console.log(`   ${k}: ${v} ms`);
        }
      }
      if (lc.failure) {
        console.log("\n=== Failure ===");
        console.log(`   Type     : ${lc.failure.type}`);
        console.log(`   Evidence : ${JSON.stringify(lc.failure.evidence)}`);
      }
    }

    const newBal = await connection.getBalance(wallet.publicKey);
    console.log(`\nWallet balance after: ${sol(newBal)} (Δ ${sol(newBal - balance)})`);
  } finally {
    await guard.stop();
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
