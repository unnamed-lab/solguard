/**
 * Jito gRPC Searcher client — provides GetNextScheduledLeader via gRPC
 * (the JSON-RPC API doesn't support this method).
 *
 * Uses @grpc/proto-loader to compile the .proto definitions at runtime.
 */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("jito-grpc");

const _dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = join(_dirname, "..", "..", "proto");
const PROTO_PATH = join(PROTO_DIR, "searcher.proto");

interface NextScheduledLeaderResponse {
  currentSlot: number | Long;
  nextLeaderSlot: number | Long;
  nextLeaderIdentity: string;
  nextLeaderRegion: string;
}

interface SearcherClient {
  GetNextScheduledLeader(
    request: { regions?: string[] },
    callback: (err: grpc.ServiceError | null, resp: NextScheduledLeaderResponse) => void,
  ): void;
}

type SearcherServiceConstructor = new (
  address: string,
  credentials: grpc.ChannelCredentials,
) => SearcherClient;

let _client: SearcherClient | undefined;

function searcherClient(): SearcherClient {
  if (_client) return _client;
  const url = new URL(config.jito.blockEngineUrl);
  const address = `${url.hostname}:443`;

  const pkgDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
    searcher: { SearcherService: SearcherServiceConstructor };
  };

  _client = new proto.searcher.SearcherService(address, grpc.credentials.createSsl());
  log.info("gRPC searcher client created", { address });
  return _client;
}

export interface NextScheduledLeader {
  currentSlot: number;
  nextLeaderSlot: number;
  nextLeaderIdentity: string;
  nextLeaderRegion?: string;
}

export function getNextScheduledLeader(timeoutMs = 5000): Promise<NextScheduledLeader> {
  return new Promise((resolve, reject) => {
    const client = searcherClient();
    const deadline = new Date();
    deadline.setMilliseconds(deadline.getMilliseconds() + timeoutMs);

    client.GetNextScheduledLeader({ regions: [] }, (err, resp) => {
      if (err) {
        reject(new Error(`gRPC GetNextScheduledLeader failed: ${err.message}`));
        return;
      }
      resolve({
        currentSlot: Number(resp.currentSlot),
        nextLeaderSlot: Number(resp.nextLeaderSlot),
        nextLeaderIdentity: resp.nextLeaderIdentity,
        nextLeaderRegion: resp.nextLeaderRegion || undefined,
      });
    });
  });
}
