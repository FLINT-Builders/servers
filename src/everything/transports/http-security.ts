import { hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import cors, { CorsOptions } from "cors";
import type { Express, NextFunction, Request, Response } from "express";

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const WILDCARD_HOSTS = ["0.0.0.0", "::"];

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// The server has no authentication, so it only listens on loopback unless the
// operator explicitly opts in to a wider bind address.
export const HTTP_HOST = process.env.MCP_HOST || "127.0.0.1";
export const HTTP_PORT = process.env.PORT || 3001;

function hostnameFor(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const ALLOWED_HOSTNAMES = [
  ...LOOPBACK_HOSTNAMES,
  ...(WILDCARD_HOSTS.includes(HTTP_HOST) ? [] : [hostnameFor(HTTP_HOST)]),
  ...parseList(process.env.MCP_ALLOWED_HOSTS).map(hostnameFor),
];

const ALLOWED_ORIGINS = parseList(process.env.MCP_ALLOWED_ORIGINS);

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === origin &&
    LOOPBACK_HOSTNAMES.includes(url.hostname)
  );
}

function originValidation(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin === undefined || isAllowedOrigin(origin)) {
    next();
    return;
  }
  res.status(403).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Forbidden: Origin not allowed",
    },
    id: null,
  });
}

/**
 * Rejects requests whose Host header is not an allowed hostname (DNS rebinding
 * protection) or whose Origin is not a loopback or explicitly allowed origin,
 * and only grants CORS access to allowed origins. Must be installed before any
 * route so that no session is created for a rejected request.
 */
export function applyHttpSecurity(
  app: Express,
  corsOptions: Omit<CorsOptions, "origin">
): void {
  app.use(hostHeaderValidation(ALLOWED_HOSTNAMES));
  app.use(originValidation);
  app.use(
    cors({
      ...corsOptions,
      origin: (origin, callback) =>
        callback(null, origin !== undefined && isAllowedOrigin(origin)),
    })
  );
}
