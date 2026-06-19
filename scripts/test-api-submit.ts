/**
 * API submission test script.
 * Builds and signs a Solana transaction locally, then POSTs it to the running
 * SolGuard API server at http://localhost:3000/submit.
 *
 * This allows end-to-end testing against the active dashboard process
 * without gRPC stream connection conflicts.
 *
 * Usage:
 *   pnpm test:api:submit            # simple SOL transfer test
 *   pnpm test:api:submit -- --swap   # Jupiter token swap test
 */
import "dotenv/config";
import {
  Connection,
  Keypair,
  SystemProgram,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";

const RPC_URL = process.env.RPC_HTTP_URL;
const SECRET_KEY_B58 = process.env.WALLET_SECRET_KEY;
const CLUSTER = process.env.SOLANA_CLUSTER ?? "mainnet-beta";

// Token the user wants to buy / send SOL to
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
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=100`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Jupiter quote failed: HTTP ${res.status}`);
  return res.json();
}

async function jupiterSwapTx(quoteResponse: unknown, walletPubkey: string): Promise<VersionedTransaction> {
  const res = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: walletPubkey,
      wrapAndUnwrapSol: true,
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
  console.log("\n=== SolGuard API Submission Test ===");
  console.log(`Cluster  : ${CLUSTER}`);
  console.log(`Wallet   : ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance  : ${sol(balance)}`);

  if (balance < 100_000) {
    console.error("Balance too low to cover fees. Fund the wallet first.");
    process.exit(1);
  }

  // ── Build transaction ──────────────────────────────────────────────────────
  let txInput: VersionedTransaction;
  let description: string;

  if (doSwap) {
    // Jupiter swap: SOL → token
    const SWAP_AMOUNT = 5_000_000; // 0.005 SOL in lamports
    console.log(`\nFetching Jupiter quote: ${sol(SWAP_AMOUNT)} SOL → ${TOKEN_MINT}`);
    const quote = await jupiterQuote(WSOL_MINT, TOKEN_MINT, SWAP_AMOUNT);
    console.log(`Quote: ~${Number(quote.outAmount)} tokens out (slippage 1%)`);
    const swapTx = await jupiterSwapTx(quote, wallet.publicKey.toBase58());
    swapTx.sign([wallet]);
    txInput = swapTx;
    description = `Jupiter swap: ${sol(SWAP_AMOUNT)} SOL → ${TOKEN_MINT}`;
  } else {
    // Simple SOL transfer
    const TRANSFER_LAMPORTS = 5_000;
    const recipient = new PublicKey(TOKEN_MINT);
    const bh = await connection.getLatestBlockhash("confirmed");
    const ix = SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: recipient,
      lamports: TRANSFER_LAMPORTS,
    });
    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([wallet]);
    txInput = tx;
    description = `${sol(TRANSFER_LAMPORTS)} SOL transfer → ${TOKEN_MINT}`;
  }

  const txBase64 = Buffer.from(txInput.serialize()).toString("base64");

  console.log(`\nSubmitting transaction payload to SolGuard API Server...`);
  console.log(`Description: ${description}`);

  try {
    const response = await fetch("http://localhost:3000/submit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        transaction: txBase64,
        urgency: "high",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API returned HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json() as any;

    console.log("\n=== API Response ===");
    if (result.landed) {
      console.log(`✓  LANDED`);
      console.log(`   Bundle ID: ${result.bundleId}`);
      console.log(`   Signature: ${result.signature}`);
      console.log(`   Slot     : ${result.slot}`);
      console.log(`   Explorer : https://solscan.io/tx/${result.signature}`);
    } else {
      console.log(`✗  DID NOT LAND`);
      console.log(`   Bundle ID: ${result.bundleId}`);
      console.log(`   Error    : ${result.error}`);
    }

    const lc = result.lifecycle;
    if (lc) {
      console.log("\n=== Lifecycle ===");
      for (const [stage, stamp] of Object.entries(lc.stages)) {
        if (stamp) console.log(`   ${stage.padEnd(12)}: slot ${(stamp as any).slot}  ${(stamp as any).ts}`);
      }
      if (lc.failure) {
        console.log("\n=== Failure ===");
        console.log(`   Type     : ${lc.failure.type}`);
        console.log(`   Evidence : ${JSON.stringify(lc.failure.evidence)}`);
      }
    }
  } catch (err) {
    console.error("\nError submitting via API:", err);
  }
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
