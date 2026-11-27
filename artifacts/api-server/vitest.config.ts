import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // @workspace/db constructs a pg Pool at import time and refuses to
      // load without this. No connection is ever opened: the acceptance
      // tests run against an embedded PGlite database injected through
      // __setCallQueueDb.
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://unused:unused@127.0.0.1:1/unused",
    },
    // PGlite starts a WASM Postgres per suite; run with process forks and sequential files to avoid V8 Wasm JIT thread crashes on Windows.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
