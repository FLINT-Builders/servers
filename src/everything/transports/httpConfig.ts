import type { CorsOptions } from "cors";

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_HOST = "127.0.0.1";

export type HttpTransportConfig = {
  port: string | number;
  host: string;
  maxSessions: number;
  sessionIdleMs: number;
  corsOrigins: string[];
};

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`Invalid ${name}=${raw}: expected a positive integer`);
    process.exit(1);
  }
  return value;
}

/**
 * Resolve the network and session limits shared by the HTTP transports.
 *
 * - `PORT` (default 3001)
 * - `EVERYTHING_HOST` (default 127.0.0.1)
 * - `EVERYTHING_MAX_SESSIONS` (default 8)
 * - `EVERYTHING_SESSION_IDLE_MS` (default 600000)
 * - `EVERYTHING_CORS_ORIGINS`: comma-separated origin allowlist (default none)
 */
export function readHttpTransportConfig(): HttpTransportConfig {
  const host = process.env.EVERYTHING_HOST?.trim() || DEFAULT_HOST;
  const corsOrigins = (process.env.EVERYTHING_CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin !== "*");
  return {
    port: process.env.PORT || 3001,
    host,
    maxSessions: readPositiveInteger(
      "EVERYTHING_MAX_SESSIONS",
      DEFAULT_MAX_SESSIONS
    ),
    sessionIdleMs: readPositiveInteger(
      "EVERYTHING_SESSION_IDLE_MS",
      DEFAULT_SESSION_IDLE_MS
    ),
    corsOrigins,
  };
}

/**
 * CORS options that only answer for explicitly allowlisted origins.
 * Origins not in the list get no `Access-Control-Allow-Origin` header.
 */
export function corsOptions(
  config: HttpTransportConfig,
  methods: string,
  exposedHeaders: string[] = []
): CorsOptions {
  return {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    methods,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    exposedHeaders,
  };
}

export function logHttpTransportConfig(config: HttpTransportConfig): void {
  console.error(
    `session-limits maxSessions=${config.maxSessions} idleMs=${config.sessionIdleMs} host=${config.host}`
  );
}
