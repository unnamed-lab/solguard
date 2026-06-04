import { config } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("jito");

/**
 * Minimal Jito Block Engine JSON-RPC client (plan §4).
 *
 * Endpoints live under `<blockEngineUrl>/api/v1/bundles` and
 * `<blockEngineUrl>/api/v1/getTipAccounts`. We implement only what SolGuard
 * needs: tip accounts, next scheduled leader, sendBundle, and the two
 * status-reconciliation methods.
 *
 * Confirmation is stream-primary (FR-16); the status methods here are
 * reconciliation only (FR-17).
 */

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export type InflightStatus = "Invalid" | "Pending" | "Failed" | "Landed";

export interface InflightBundleStatus {
  bundle_id: string;
  status: InflightStatus;
  landed_slot: number | null;
}

export interface BundleStatus {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
}

export class JitoClient {
  constructor(
    private readonly baseUrl = config.jito.blockEngineUrl,
    private readonly fallbacks = config.jito.fallbacks,
  ) {}

  /** 8 static tip accounts; caller picks one at random per bundle (FR-10). */
  async getTipAccounts(): Promise<string[]> {
    return this.rpc<string[]>("/api/v1/bundles", "getTipAccounts", []);
  }

  /**
   * Submit a bundle of base58/base64-encoded signed transactions (FR-13).
   * Returns the bundle_id. Tries fallbacks on transport failure (0-2 max).
   */
  async sendBundle(encodedTxs: string[], encoding: "base58" | "base64" = "base64"): Promise<string> {
    return this.rpc<string>("/api/v1/bundles", "sendBundle", [encodedTxs, { encoding }]);
  }

  /** Early reconciliation signal (FR-17). */
  async getInflightBundleStatuses(bundleIds: string[]): Promise<InflightBundleStatus[]> {
    const res = await this.rpc<{ value: InflightBundleStatus[] }>(
      "/api/v1/bundles",
      "getInflightBundleStatuses",
      [bundleIds],
    );
    return res.value ?? [];
  }

  /** Later reconciliation signal (FR-17). */
  async getBundleStatuses(bundleIds: string[]): Promise<BundleStatus[]> {
    const res = await this.rpc<{ value: BundleStatus[] }>(
      "/api/v1/bundles",
      "getBundleStatuses",
      [bundleIds],
    );
    return res.value ?? [];
  }

  // ---- transport -----------------------------------------------------------

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const endpoints = [this.baseUrl, ...this.fallbacks].slice(0, 3);
    let lastErr: unknown;
    for (const base of endpoints) {
      try {
        return await this.post<T>(base + path, method, params);
      } catch (err) {
        lastErr = err;
        log.warn("jito rpc failed; trying next endpoint", { base, method, err: String(err) });
      }
    }
    throw new Error(`Jito RPC ${method} failed on all endpoints: ${String(lastErr)}`);
  }

  private async post<T>(url: string, method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as JsonRpcResponse<T>;
    if (json.error) {
      throw new Error(`RPC error ${json.error.code}: ${json.error.message}`);
    }
    if (json.result === undefined) {
      throw new Error(`RPC ${method} returned no result`);
    }
    return json.result;
  }
}

let _client: JitoClient | undefined;
export function jitoClient(): JitoClient {
  if (!_client) _client = new JitoClient();
  return _client;
}
