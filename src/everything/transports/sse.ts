import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createServer } from "../server/index.js";
import cors from "cors";
import {
  corsOptions,
  logHttpTransportConfig,
  readHttpTransportConfig,
} from "./httpConfig.js";

console.error("Starting SSE server...");

const config = readHttpTransportConfig();
logHttpTransportConfig(config);

// Only origins listed in EVERYTHING_CORS_ORIGINS may call the server from a browser
const app = express();
app.use(cors(corsOptions(config, "GET,POST")));

// Map sessionId to transport for each client
const transports: Map<string, SSEServerTransport> = new Map<
  string,
  SSEServerTransport
>();

// Handle GET requests for new SSE streams
app.get("/sse", async (req, res) => {
  // Session Id should not exist for GET /sse requests
  if (req?.query?.sessionId) {
    console.error(
      "Client Reconnecting? This shouldn't happen; when client has a sessionId, GET /sse should not be called again.",
      req.query.sessionId
    );
    res.status(400).send("GET /sse does not accept a sessionId");
    return;
  }

  // The check and the insert below run with no await in between, so
  // concurrent connections cannot exceed the cap
  if (transports.size >= config.maxSessions) {
    console.error(
      `Rejecting new session: ${config.maxSessions} session limit reached`
    );
    res.status(503).send("Service Unavailable: session limit reached");
    return;
  }

  const { server, cleanup } = createServer();

  // Create and store transport for the new session
  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  // Handle close of connection
  server.server.onclose = async () => {
    console.error("Client Disconnected: ", sessionId);
    if (transports.get(sessionId) === transport) transports.delete(sessionId);
    cleanup(sessionId);
  };

  // Connect server to transport
  try {
    await server.connect(transport);
    console.error("Client Connected: ", sessionId);
  } catch (error) {
    console.error("Error connecting SSE client:", error);
    await transport.close().catch(() => {});
    if (transports.get(sessionId) === transport) transports.delete(sessionId);
  }
});

// Handle POST requests for client messages
app.post("/message", async (req, res) => {
  // Session Id should exist for POST /message requests
  const sessionId = req?.query?.sessionId as string;

  // Get the transport for this session and use it to handle the request
  const transport = transports.get(sessionId);
  if (transport) {
    console.error("Client Message from", sessionId);
    await transport.handlePostMessage(req, res);
  } else {
    console.error(`No transport found for sessionId ${sessionId}`);
    res.status(404).send("Session not found");
  }
});

// Start the express server
app.listen(config.port as number, config.host, () => {
  console.error(
    `Server is running on port ${config.port} (host ${config.host})`
  );
});
