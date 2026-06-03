import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL writer (NFR-4: auditable, immutable logs). One JSON object
 * per line. BigInt is serialized to string so slot numbers survive round-trip.
 */
export class JsonlWriter {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: unknown): void {
    appendFileSync(this.path, JSON.stringify(entry, bigintReplacer) + "\n");
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
