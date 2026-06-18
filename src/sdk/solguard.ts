import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { config } from "../config.js";
import { bridge } from "../events/bridge.js";
import { StreamManager } from "../stream/manager.js";
import { CongestionOracle, type CongestionSnapshot } from "../network/congestion.js";
import { LeaderWindowDetector, type LeaderWindow } from "../network/leader.js";
import { LifecycleTracker } from "../lifecycle/tracker.js";
import { classifyFailure } from "../lifecycle/classifier.js";
import { tipFloorService } from "../tips/tipFloor.js";
import { computeTip } from "../tips/model.js";
import {
  buildBundle,
  fetchConfirmedBlockhash,
  type BlockhashInfo,
  type BuiltBundle,
} from "../bundle/builder.js";
import { submitBundle, type SubmitResult } from "../bundle/submitter.js";
import { jitoClient } from "../jito/client.js";
import { aiAgentClient } from "../agent/agent.js";
import { decisionLedger } from "../agent/ledger.js";
import type { AgentInput } from "../agent/contract.js";
import type { FailureRecord, LifecycleEntry } from "../lifecycle/types.js";
import { wallet, connection } from "../solana/connection.js";
import { logger } from "../util/log.js";

const log = logger("sdk");

export interface SolGuardConfig {
  wallet?: Keypair;
  connection?: Connection;
  submit?: boolean;
  maxAttempts?: number;
  confirmTimeoutMs?: number;
  submitCooldownMs?: number;
}

export interface SolGuardSubmitOptions {
  urgency?: "normal" | "high";
  customTipLamports?: number;
}

export interface SolGuardResult {
  bundleId: string;
  landed: boolean;
  signature?: string;
  slot?: number;
  lifecycle: LifecycleEntry;
  error?: string;
}

interface AttemptCtx {
  attempt: number;
  history: Array<{ attempt: number; outcome: string }>;
}

export class SolGuard {
  private sdkWallet: Keypair;
  private sdkConnection: Connection;
  private submitEnabled: boolean;
  private maxAttempts: number;
  private confirmTimeoutMs: number;
  private submitCooldownMs: number;

  private stream?: StreamManager;
  private oracle?: CongestionOracle;
  private leader?: LeaderWindowDetector;
  private lifecycle?: LifecycleTracker;
  private tipFloor = tipFloorService();
  private agent = aiAgentClient();
  private jito = jitoClient();

  private initialized = false;
  private streamReaderPromise?: Promise<void>;

  constructor(cfg: SolGuardConfig = {}) {
    this.sdkConnection = cfg.connection ?? connection();
    try {
      this.sdkWallet = cfg.wallet ?? wallet();
    } catch (err) {
      log.debug("No wallet provided, some methods requiring signatures will fail", { err: String(err) });
      this.sdkWallet = null as any;
    }
    this.submitEnabled = cfg.submit ?? true;
    this.maxAttempts = cfg.maxAttempts ?? Number(process.env.LIVE_MAX_ATTEMPTS ?? 3);
    this.confirmTimeoutMs = cfg.confirmTimeoutMs ?? Number(process.env.LIVE_CONFIRM_TIMEOUT_MS ?? 30_000);
    this.submitCooldownMs = cfg.submitCooldownMs ?? Number(process.env.LIVE_SUBMIT_COOLDOWN_MS ?? 20_000);
  }

  /** Initialize the Yellowstone stream manager and other background observation loops */
  async start(): Promise<void> {
    if (this.initialized) return;
    log.info("Starting SolGuard SDK core...");

    this.stream = new StreamManager();
    this.oracle = new CongestionOracle();
    this.leader = new LeaderWindowDetector();
    this.lifecycle = new LifecycleTracker();

    if (this.sdkWallet) {
      this.stream.trackAccounts([this.sdkWallet.publicKey.toBase58()]);
    }

    await this.stream.start();
    this.initialized = true;

    // Drain the stream so the oracle/lifecycle stay live.
    this.streamReaderPromise = (async () => {
      let lastTelemetryEmit = 0;
      let lastLeaderPoll = 0;
      let cachedLeaderSlot: number | null = null;
      let lastTipFetchedAt = 0;

      try {
        for await (const ev of this.stream!.queue) {
          if (ev.kind === "slot") {
            this.oracle!.ingest(ev);
            this.lifecycle!.onSlotStatus(Number(ev.slot), ev.status, ev.ts);

            const now = Date.now();

            // Refresh leader window every 5 s (fire-and-forget)
            if (now - lastLeaderPoll > 5_000) {
              lastLeaderPoll = now;
              this.leader!.window()
                .then((w) => { cachedLeaderSlot = w.nextJitoLeaderSlot ?? null; })
                .catch(() => {});
            }

            // Emit telemetry at ~400 ms cadence to match frontend polling
            if (now - lastTelemetryEmit > 400) {
              lastTelemetryEmit = now;
              const snap = this.oracle!.snapshot();

              // Include tip floor only when it has changed since last emission
              const tf = this.tipFloor.getCached();
              const tipFloor = tf && tf.fetchedAt !== lastTipFetchedAt ? tf : undefined;
              if (tipFloor) lastTipFetchedAt = tipFloor.fetchedAt;

              bridge.emit("telemetry", {
                slot: Number(ev.slot),
                skipRate: snap.skipRate * 100, // fraction → percentage for the frontend
                pcDelta: snap.p2cMsP50,
                jitoLeaderSlot: cachedLeaderSlot,
                tipFloor,
              });
            }
          } else {
            this.lifecycle!.onTxEvent(ev, "processed");
          }
        }
      } catch (err) {
        log.error("Stream reader loop encountered error", { err: String(err) });
      }
    })();
  }

  /** Stop background observation loops */
  async stop(): Promise<void> {
    if (!this.initialized) return;
    log.info("Stopping SolGuard SDK core...");
    await this.stream?.stop();
    this.initialized = false;
    try {
      await this.streamReaderPromise;
    } catch (err) {
      // ignore
    }
  }

  /** Get the current status of the network observation stream */
  status() {
    return {
      initialized: this.initialized,
      stream: this.stream?.metrics(),
      congestion: this.oracle?.snapshot(),
    };
  }

  /**
   * Hand a transaction to SolGuard. It automatically tips, bundles, submits,
   * tracks landing, and AI-retries on failure.
   */
  async submit(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer,
    opts: SolGuardSubmitOptions = {}
  ): Promise<SolGuardResult> {
    // 1. Ensure stack is started
    if (!this.initialized) {
      log.info("SDK not started; starting automatically...");
      await this.start();
    }

    // 2. Parse transaction input format
    const parsed = this.parseTransactionInput(txInput);

    // 3. Track is-presigned flag
    const isPresigned = !(Array.isArray(parsed));

    // 4. Run submit-retry loop
    return this.runOneSubmitAttempt({ attempt: 1, history: [] }, parsed, isPresigned, opts);
  }

  private parseTransactionInput(
    txInput: VersionedTransaction | Transaction | TransactionInstruction[] | string | Buffer
  ): VersionedTransaction | Transaction | TransactionInstruction[] {
    if (Array.isArray(txInput)) {
      return txInput;
    }
    if (txInput instanceof VersionedTransaction || txInput instanceof Transaction) {
      return txInput;
    }

    let buffer: Buffer;
    if (typeof txInput === "string") {
      try {
        buffer = Buffer.from(txInput, "base64");
      } catch {
        try {
          buffer = Buffer.from(bs58.decode(txInput));
        } catch {
          throw new Error("Invalid transaction encoding: string must be base64 or base58");
        }
      }
    } else if (Buffer.isBuffer(txInput) || (txInput as any) instanceof Uint8Array) {
      buffer = Buffer.from(txInput);
    } else {
      throw new Error("Invalid transaction input type");
    }

    // Try deserializing as VersionedTransaction first, fallback to legacy Transaction
    try {
      return VersionedTransaction.deserialize(buffer);
    } catch {
      try {
        return Transaction.from(buffer);
      } catch (err) {
        throw new Error(`Failed to deserialize transaction: ${String(err)}`);
      }
    }
  }

  private async runOneSubmitAttempt(
    ctx: AttemptCtx,
    parsed: VersionedTransaction | Transaction | TransactionInstruction[],
    isPresigned: boolean,
    opts: SolGuardSubmitOptions,
    override?: { newTipLamports?: number }
  ): Promise<SolGuardResult> {
    const tf = await this.tipFloor.get();
    const congestion = this.oracle!.snapshot();

    // Determine Jito tip account
    const tipAccount = await this.pickTipAccount();

    // Price tip dynamically
    const tipLamports = override?.newTipLamports != null
      ? this.clampTip(override.newTipLamports, tf.p25)
      : opts.customTipLamports != null
        ? this.clampTip(opts.customTipLamports, tf.p25)
        : computeTip({
            tipFloor: tf,
            congestionMultiplier: congestion.congestionMultiplier,
            urgency: opts.urgency ?? "normal",
          }).lamports;

    // Fetch confirmed leader window info to track submission targets
    let win: LeaderWindow | undefined;
    try {
      win = await this.leader!.window();
    } catch (err) {
      log.debug("leader window fetch failed in submit, using slot fallback", { err: String(err) });
    }

    const currentSlot = win?.currentSlot ?? (await this.sdkConnection.getSlot("confirmed"));
    const targetLeaderSlot = win?.nextJitoLeaderSlot ?? (currentSlot + 4);

    // Build the bundle
    let built: BuiltBundle;
    if (Array.isArray(parsed)) {
      if (!this.sdkWallet) {
        throw new Error("WALLET_SECRET_KEY is required to sign raw instructions.");
      }
      built = await this.buildBundleFromInstructions(parsed, tipLamports, tipAccount);
    } else {
      built = await this.buildBundleFromTx(parsed, tipLamports, tipAccount);
    }

    if (!this.submitEnabled) {
      log.info("SolGuard SDK: submit disabled (dry-run). Built bundle info:", {
        attempt: ctx.attempt,
        tipLamports,
        signatures: built.signatures,
      });
      return {
        bundleId: `dry_run_${Math.random().toString(36).substring(2, 10)}`,
        landed: false,
        lifecycle: {
          bundle_id: "dry_run",
          signatures: built.signatures,
          tip_lamports: tipLamports,
          tip_account: tipAccount,
          attempt: ctx.attempt,
          stages: {},
          deltas_ms: {},
          failure: null,
          confirmed_via: null,
        },
      };
    }

    // Submit bundle
    const result = await submitBundle(built);
    this.lifecycle!.track(result, ctx.attempt, currentSlot);

    // If Jito marks the bundle Invalid early (no auth token / deprioritised),
    // fall back to a direct sendTransaction so the tx still lands via normal TPU.
    this.jitoInvalidFallback(result.bundleId, built).catch((err) =>
      log.debug("jito-invalid RPC fallback error", { err: String(err) })
    );

    // Wait for confirmation on Yellowstone stream
    const landed = await this.awaitConfirmation(result.bundleId);
    const lifecycleEntry = this.lifecycle!.get(result.bundleId) || {
      bundle_id: result.bundleId,
      signatures: result.signatures,
      tip_lamports: tipLamports,
      tip_account: tipAccount,
      attempt: ctx.attempt,
      stages: {},
      deltas_ms: {},
      failure: null,
      confirmed_via: null,
    };

    if (landed) {
      return {
        bundleId: result.bundleId,
        landed: true,
        signature: result.signatures[0],
        slot: lifecycleEntry.stages.processed?.slot,
        lifecycle: lifecycleEntry,
      };
    }

    // Handle failure path
    if (ctx.attempt >= this.maxAttempts) {
      const failure = this.classifyTimeout(result.bundleId, currentSlot, targetLeaderSlot, tipLamports, tf.p50, congestion);
      this.lifecycle!.fail(result.bundleId, failure);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
        error: `Max attempts (${this.maxAttempts}) exceeded without landing. Last failure: ${failure.type}`,
      };
    }

    const failure = this.classifyTimeout(result.bundleId, currentSlot, targetLeaderSlot, tipLamports, tf.p50, congestion);
    this.lifecycle!.fail(result.bundleId, failure);

    // Prepare AI agent context
    const agentInput: AgentInput = {
      event: "bundle_failed",
      failure,
      bundle: {
        attempt: ctx.attempt,
        tip_lamports: tipLamports,
        tip_account: result.tipAccount,
        submitted_slot: currentSlot,
        target_leader_slot: targetLeaderSlot,
      },
      network: {
        current_slot: win?.currentSlot ?? currentSlot,
        slot_skip_rate_64: congestion.skipRate,
        processed_to_confirmed_ms_p50: congestion.p2cMsP50,
        tip_floor: tf,
        next_jito_leader_slot: win?.nextJitoLeaderSlot ?? targetLeaderSlot,
        slots_until_jito_leader: win?.slotsUntilJitoLeader ?? 0,
      },
      history: ctx.history,
    };

    // Add presigned flag in prompt context (agent reads free context if needed)
    // We can run the AI agent
    const { decision, ledgerTs } = await this.agent.decide(agentInput, "real_failure");
    log.info("Agent retry decision received", {
      action: decision.action,
      rootCause: decision.root_cause,
      confidence: decision.confidence,
    });

    const nextHistory = [
      ...ctx.history,
      { attempt: ctx.attempt, outcome: failure.type },
    ];

    if (decision.action === "abort") {
      decisionLedger().updateOutcome(ledgerTs, result.bundleId, `aborted — ${decision.root_cause}`);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
        error: `Aborted by AI Agent: ${decision.root_cause}. Diagnosis: ${decision.diagnosis}`,
      };
    }

    if (decision.action === "hold") {
      decisionLedger().updateOutcome(ledgerTs, result.bundleId, "held — retry on next window");
      // Wait for cooldown or next window before retrying
      await this.sleep(this.submitCooldownMs);
      return this.runOneSubmitAttempt(
        { attempt: ctx.attempt + 1, history: nextHistory },
        parsed,
        isPresigned,
        opts,
        { newTipLamports: decision.params.new_tip_lamports }
      );
    }

    // action === "retry"
    if (decision.params.refresh_blockhash && isPresigned) {
      const abortMsg = "AI Agent requested refresh_blockhash for a pre-signed transaction. Re-signing requires the private key.";
      decisionLedger().updateOutcome(ledgerTs, result.bundleId, `aborted — ${abortMsg}`);
      return {
        bundleId: result.bundleId,
        landed: false,
        lifecycle: this.lifecycle!.get(result.bundleId) || lifecycleEntry,
        error: abortMsg,
      };
    }

    // Execute retry
    const outcome = await this.runOneRetry(
      { attempt: ctx.attempt + 1, history: nextHistory },
      parsed,
      isPresigned,
      opts,
      decision.params.refresh_blockhash,
      decision.params.new_tip_lamports
    );

    decisionLedger().updateOutcome(ledgerTs, result.bundleId, outcome.landed ? `landed @ slot ${outcome.slot}` : `failed retry: ${outcome.error}`);
    return outcome;
  }

  private async runOneRetry(
    ctx: AttemptCtx,
    parsed: VersionedTransaction | Transaction | TransactionInstruction[],
    isPresigned: boolean,
    opts: SolGuardSubmitOptions,
    refreshBlockhash: boolean,
    newTipLamports: number
  ): Promise<SolGuardResult> {
    let nextParsed = parsed;
    if (refreshBlockhash && !isPresigned) {
      log.info("Refreshing blockhash for instructions retry...");
      // Re-sign occurs during building phase when we call buildBundleFromInstructions with no blockhash (will fetch fresh)
      nextParsed = parsed;
    }
    return this.runOneSubmitAttempt(ctx, nextParsed, isPresigned, opts, { newTipLamports });
  }

  private async buildBundleFromTx(
    tx: VersionedTransaction | Transaction,
    tipLamports: number,
    tipAccount: string
  ): Promise<BuiltBundle> {
    const blockhash = tx instanceof VersionedTransaction
      ? tx.message.recentBlockhash
      : tx.recentBlockhash;

    if (!blockhash) {
      throw new Error("Transaction is missing recentBlockhash");
    }

    if (!this.sdkWallet) {
      throw new Error("WALLET_SECRET_KEY is required to sign Jito tip transactions.");
    }

    // Build the tip transfer transaction
    const tipPubkey = new PublicKey(tipAccount);
    const tipIx = SystemProgram.transfer({
      fromPubkey: this.sdkWallet.publicKey,
      toPubkey: tipPubkey,
      lamports: tipLamports,
    });

    const tipMsg = new TransactionMessage({
      payerKey: this.sdkWallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipIx],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([this.sdkWallet]);

    const devTxBase64 = Buffer.from(tx.serialize()).toString("base64");
    const tipTxBase64 = Buffer.from(tipTx.serialize()).toString("base64");

    const devSig = tx instanceof VersionedTransaction
      ? bs58.encode(tx.signatures[0]!)
      : bs58.encode(tx.signature!);

    const tipSig = bs58.encode(tipTx.signatures[0]!);

    // Estimate validity slot based on current slot
    const slot = await this.sdkConnection.getSlot("confirmed");

    return {
      encodedTxs: [devTxBase64, tipTxBase64],
      signatures: [devSig, tipSig],
      tipAccount,
      tipLamports,
      blockhash,
      lastValidBlockHeight: slot + 150, // estimated
      fetchedAtSlot: slot,
    };
  }

  private async buildBundleFromInstructions(
    instructions: TransactionInstruction[],
    tipLamports: number,
    tipAccount: string
  ): Promise<BuiltBundle> {
    const bh = await fetchConfirmedBlockhash();
    const tipPubkey = new PublicKey(tipAccount);

    const ixs = [...instructions];
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: this.sdkWallet.publicKey,
        toPubkey: tipPubkey,
        lamports: tipLamports,
      })
    );

    const msg = new TransactionMessage({
      payerKey: this.sdkWallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    tx.sign([this.sdkWallet]);

    const sig = bs58.encode(tx.signatures[0]!);
    const txBase64 = Buffer.from(tx.serialize()).toString("base64");

    return {
      encodedTxs: [txBase64],
      signatures: [sig],
      tipAccount,
      tipLamports,
      blockhash: bh.blockhash,
      lastValidBlockHeight: bh.lastValidBlockHeight,
      fetchedAtSlot: bh.fetchedAtSlot,
    };
  }

  /**
   * Polls Jito's inflight status for 8 s. If the bundle is already "Invalid"
   * (block engine rejected it — usually lack of auth token), we fall back to a
   * direct sendTransaction via our RPC so the transaction still lands via the
   * normal TPU path. The Yellowstone stream will confirm it once it processes.
   */
  private async jitoInvalidFallback(bundleId: string, built: BuiltBundle): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const GIVE_UP_MS = 8_000;
    const deadline = Date.now() + GIVE_UP_MS;

    while (Date.now() < deadline) {
      await this.sleep(POLL_INTERVAL_MS);
      try {
        const statuses = await this.jito.getInflightBundleStatuses([bundleId]);
        const s = statuses.find((x) => x.bundle_id === bundleId);
        if (s?.status === "Invalid") {
          log.warn("bundle marked Invalid by Jito; submitting via RPC fallback", { bundleId });
          for (const encodedTx of built.encodedTxs) {
            const buf = Buffer.from(encodedTx, "base64");
            const tx = VersionedTransaction.deserialize(buf);
            await this.sdkConnection.sendRawTransaction(tx.serialize(), {
              skipPreflight: false,
              maxRetries: 3,
            }).then((sig) => log.info("RPC fallback tx sent", { sig }))
              .catch((err) => log.debug("RPC fallback tx send error", { err: String(err) }));
          }
          return;
        }
        if (s?.status === "Landed" || s?.status === "Pending") return;
      } catch (err) {
        log.debug("inflight status check failed in fallback", { err: String(err) });
      }
    }
  }

  private async pickTipAccount(): Promise<string> {
    const accounts = await this.jito.getTipAccounts();
    return accounts[Math.floor(Math.random() * accounts.length)]!;
  }

  private clampTip(lamports: number, floor: number): number {
    return Math.min(config.tips.ceilingLamports, Math.max(floor, Math.round(lamports)));
  }

  private classifyTimeout(
    bundleId: string,
    currentSlot: number,
    targetLeaderSlot: number,
    tipLamports: number,
    tipFloorP50: number,
    congestion: CongestionSnapshot
  ): FailureRecord {
    return classifyFailure({
      bundleId,
      currentSlot,
      neverProcessed: true,
      targetLeaderSlot,
      tipLamports,
      tipFloorP50,
      congestion,
    });
  }

  private async awaitConfirmation(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + this.confirmTimeoutMs;
    while (Date.now() < deadline) {
      const entry = this.lifecycle!.get(bundleId);
      if (entry?.stages.confirmed) return true;
      if (entry?.failure) return false;
      await this.sleep(500);
    }
    // Reconciliation fallback
    try {
      const statuses = await this.jito.getBundleStatuses([bundleId]);
      const s = statuses.find((x) => x.bundle_id === bundleId);
      if (s && (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized")) {
        this.lifecycle!.reconcile(bundleId, s.confirmation_status, s.slot);
        return true;
      }
    } catch (err) {
      log.debug("reconciliation failed in SDK await", { err: String(err) });
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
