import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import type { BlockhashInfo } from "../bundle/builder.js";
import type { LeaderWindow } from "../network/leader.js";
import { logger } from "../util/log.js";

const log = logger("faults");

export type FaultType =
  | "blockhash_expired"
  | "fee_too_low"
  | "bundle_dropped_leader_skip"
  | "compute_exceeded";

export class FaultInjector {
  private activeFault: FaultType | null = null;

  setFault(fault: FaultType | null): void {
    this.activeFault = fault;
    if (fault) {
      log.info(`Active fault injected: ${fault}`);
    } else {
      log.info("Fault cleared");
    }
  }

  getActiveFault(): FaultType | null {
    return this.activeFault;
  }

  hasFault(fault: FaultType): boolean {
    return this.activeFault === fault;
  }

  /**
   * If "blockhash_expired" fault is active, returns an expired blockhash info
   * where the lastValidBlockHeight is set to a past slot.
   */
  injectBlockhash(realBh: BlockhashInfo): BlockhashInfo {
    if (this.activeFault === "blockhash_expired") {
      log.info("Injecting stale/expired blockhash");
      return {
        // A generic valid-looking but dummy/stale blockhash (must decode to 32 bytes)
        blockhash: "SysvarCrent11111111111111111111111111111111",
        lastValidBlockHeight: realBh.lastValidBlockHeight - 200,
        fetchedAtSlot: realBh.fetchedAtSlot - 150,
      };
    }
    return realBh;
  }

  /**
   * If "fee_too_low" fault is active, forces the tip to drop to 1 lamport,
   * which is significantly below Jito's p25 percentile floor.
   */
  injectTip(realTipLamports: number, p25Floor: number): number {
    if (this.activeFault === "fee_too_low") {
      const lowTip = 1; // 1 lamport
      log.info("Injecting tip too low fault", { original: realTipLamports, injected: lowTip });
      return lowTip; // no-hardcoded-tip-ok: fault injector specific simulation
    }
    return realTipLamports;
  }

  /**
   * If "bundle_dropped_leader_skip" fault is active, modifies the leader window
   * to simulate leader skip or window closed conditions.
   */
  injectLeaderWindow(realWindow: LeaderWindow): LeaderWindow {
    if (this.activeFault === "bundle_dropped_leader_skip") {
      log.info("Injecting leader skip / window closed fault");
      return {
        ...realWindow,
        inSubmitWindow: false,
        slotsUntilJitoLeader: -1,
        // Trigger simulated leader skip indicator
      };
    }
    return realWindow;
  }

  /**
   * If "compute_exceeded" fault is active, appends a ComputeBudgetProgram instruction
   * requesting way too many compute units (e.g. 15,000,000 CUs, exceeding standard limits),
   * causing simulation failures.
   */
  injectComputeError(instructions: TransactionInstruction[]): TransactionInstruction[] {
    if (this.activeFault === "compute_exceeded") {
      log.info("Injecting compute exceeded fault instruction");
      const budgetExceededIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 15_000_000, // exceeds Solana's max 1.4m CU transaction limit
      });
      return [...instructions, budgetExceededIx];
    }
    return instructions;
  }
}

let _faultInjector: FaultInjector | undefined;
export function faultInjector(): FaultInjector {
  if (!_faultInjector) _faultInjector = new FaultInjector();
  return _faultInjector;
}
