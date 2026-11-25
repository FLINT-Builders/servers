import {
  StreamableHTTPServerTransport,
  EventStore,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { createServer } from "../server/index.js";
import { randomUUID } from "node:crypto";
import cors from "cors";
import {
  corsOptions,
  logHttpTransportConfig,
  readHttpTransportConfig,
} from "./httpConfig.js";

// Upper bound on events retained per session for resumability
const MAX_STORED_EVENTS = 1000;

// Simple in-memory event store for SSE resumability
class InMemoryEventStore implements EventStore {
  private events: Map<string, { streamId: string; message: unknown }> =
    new Map();

  async storeEvent(streamId: string, message: unknown): Promise<string> {
    const eventId = randomUUID();
    this.events.set(eventId, { streamId, message });
    while (this.events.size > MAX_STORED_EVENTS) {
      const oldest = this.events.keys().next().value as string;
      this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: unknown) => Promise<void> }
  ): Promise<string> {
    const entries = Array.from(this.events.entries());
    const startIndex = entries.findIndex(([id]) => id === lastEventId);
    if (startIndex === -1) return lastEventId;

    let lastId: string = lastEventId;
    for (let i = startIndex + 1; i < entries.length; i++) {
      const [eventId, { message }] = entries[i];
      await send(eventId, message);
      lastId = eventId;
    }
    return lastId;
  }
}

type Session = {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  activeRequests: number;
};

console.log("Starting Streamable HTTP server...");

const config = readHttpTransportConfig();
logHttpTransportConfig(config);

// Only origins listed in EVERYTHING_CORS_ORIGINS may call the server from a browser
const app = express();
app.use(
  cors(
    corsOptions(config, "GET,POST,DELETE", [
      "mcp-session-id",
      "last-event-id",
      "mcp-protocol-version",
    ])
  )
);

// Map sessionId to the session's transport and activity bookkeeping
const sessions: Map<string, Session> = new Map<string, Session>();

// Initialize requests that hold a session slot but are not in `sessions` yet
let pendingInitializations = 0;

/**
 * Mark a request as in flight for a session until its response closes.
 * Must be called before the handler's first await, so the session cannot be
 * swept between lookup and handling.
 */
function trackRequest(session: Session, res: Response): void {
  session.activeRequests += 1;
  session.lastActivity = Date.now();
  res.once("close", () => {
    session.activeRequests -= 1;
    session.lastActivity = Date.now();
  });
}

function sendJsonRpcError(
  req: Request,
  res: Response,
  status: number,
  code: number,
  message: string
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: req?.body?.id,
  });
}

// Close sessions that have no open request and no activity within the idle timeout.
// Closing the transport fires the server's onclose, which removes the session.
const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - config.sessionIdleMs;
  for (const [sessionId, session] of sessions) {
    if (session.activeRequests > 0 || session.lastActivity > cutoff) {
      continue;
    }
    console.log(`Closing idle session ${sessionId}`);
    session.transport
      .close()
      .catch((error) => {
        console.log(`Error closing idle session ${sessionId}:`, error);
      })
      .finally(() => {
        if (sessions.get(sessionId) === session) sessions.delete(sessionId);
      });
  }
}, Math.max(1, Math.floor(config.sessionIdleMs / 2)));
sweepTimer.unref();

// Handle POST requests for client messages
app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP POST request");
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(
        req,
        res,
        400,
        -32000,
        "Bad Request: No valid session ID provided"
      );
      return;
    }
    trackRequest(session, res);
    try {
      // The existing transport is already connected to the server
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.log("Error handling MCP request:", error);
      if (!res.headersSent) {
        sendJsonRpcError(req, res, 500, -32603, "Internal server error");
      }
    }
    return;
  }

  // New initialization request: reserve a slot before any await so a burst
  // of concurrent initializes cannot exceed the cap.
  if (sessions.size + pendingInitializations >= config.maxSessions) {
    console.log(
      `Rejecting new session: ${config.maxSessions} session limit reached`
    );
    sendJsonRpcError(
      req,
      res,
      503,
      -32000,
      "Service Unavailable: session limit reached"
    );
    return;
  }
  pendingInitializations += 1;
  let reserved = true;
  const releaseReservation = () => {
    if (!reserved) return;
    reserved = false;
    pendingInitializations -= 1;
  };

  let transport: StreamableHTTPServerTransport | undefined;
  try {
    const { server, cleanup } = createServer();
    const eventStore = new InMemoryEventStore();
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      eventStore, // Enable resumability
      onsessioninitialized: (newSessionId: string) => {
        // Store the session when it is initialized, before the response is
        // sent, so follow-up requests can find it.
        console.log(`Session initialized with ID: ${newSessionId}`);
        releaseReservation();
        sessions.set(newSessionId, session);
      },
    });
    transport = newTransport;
    const session: Session = {
      transport: newTransport,
      lastActivity: Date.now(),
      activeRequests: 0,
    };
    trackRequest(session, res);

    // Clean up when the transport closes (DELETE, idle sweep, or shutdown)
    let cleanedUp = false;
    server.server.onclose = async () => {
      const sid = newTransport.sessionId;
      if (sid && sessions.get(sid) === session) {
        console.log(
          `Transport closed for session ${sid}, removing from transports map`
        );
        sessions.delete(sid);
      }
      releaseReservation();
      if (!cleanedUp) {
        cleanedUp = true;
        cleanup(sid);
      }
    };

    // Connect the transport to the MCP server BEFORE handling the request
    // so responses can flow back through the same transport
    await server.connect(newTransport);
    await newTransport.handleRequest(req, res);

    // The request did not initialize a session (e.g. it was not an initialize
    // request), so nothing can reach this server again.
    const sid = newTransport.sessionId;
    if (!sid || sessions.get(sid) !== session) {
      await newTransport.close();
    }
  } catch (error) {
    console.log("Error handling MCP request:", error);
    if (transport) {
      await transport.close().catch(() => {});
    }
    if (!res.headersSent) {
      sendJsonRpcError(req, res, 500, -32603, "Internal server error");
    }
  } finally {
    releaseReservation();
  }
});

// Handle GET requests for SSE streams
app.get("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP GET request");
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    sendJsonRpcError(
      req,
      res,
      400,
      -32000,
      "Bad Request: No valid session ID provided"
    );
    return;
  }
  trackRequest(session, res);

  // Check for Last-Event-ID header for resumability
  const lastEventId = req.headers["last-event-id"] as string | undefined;
  if (lastEventId) {
    console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
  } else {
    console.log(`Establishing new SSE stream for session ${sessionId}`);
  }

  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.log("Error handling SSE stream request:", error);
    if (!res.headersSent) {
      sendJsonRpcError(req, res, 500, -32603, "Internal server error");
    }
  }
});

// Handle DELETE requests for session termination
app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    sendJsonRpcError(
      req,
      res,
      400,
      -32000,
      "Bad Request: No valid session ID provided"
    );
    return;
  }
  trackRequest(session, res);

  console.log(`Received session termination request for session ${sessionId}`);

  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    console.log("Error handling session termination:", error);
    if (!res.headersSent) {
      sendJsonRpcError(
        req,
        res,
        500,
        -32603,
        "Error handling session termination"
      );
    }
  }
});

// Start the server
const server = app.listen(config.port as number, config.host, () => {
  console.error(
    `MCP Streamable HTTP Server listening on port ${config.port} (host ${config.host})`
  );
});

// Handle server errors
server.on("error", (err: unknown) => {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (code === "EADDRINUSE") {
    console.error(
      `Failed to start: Port ${config.port} is already in use. Set PORT to a free port or stop the conflicting process.`
    );
  } else {
    console.error("HTTP server encountered an error while starting:", err);
  }
  // Ensure a non-zero exit so npm reports the failure instead of silently exiting
  process.exit(1);
});

// Handle server shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  clearInterval(sweepTimer);

  // Close all active transports to properly clean up resources
  for (const [sessionId, session] of Array.from(sessions)) {
    try {
      console.log(`Closing transport for session ${sessionId}`);
      await session.transport.close();
      sessions.delete(sessionId);
    } catch (error) {
      console.log(`Error closing transport for session ${sessionId}:`, error);
    }
  }

  console.log("Server shutdown complete");
  process.exit(0);
});
