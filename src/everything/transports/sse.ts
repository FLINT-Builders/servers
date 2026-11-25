import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { createServer } from "../server/index.js";
import cors from "cors";

console.error("Starting SSE server...");

// Express app with permissive CORS for testing with Inspector direct connect mode
const app = express();
app.use(
  cors({
    origin: "*", // use "*" with caution in production
    methods: "GET,POST",
    preflightContinue: false,
    optionsSuccessStatus: 204,
  })
);

// Map sessionId to transport for each client
const transports: Map<string, SSEServerTransport> = new Map<
  string,
  SSEServerTransport
>();

// Handle GET requests for new SSE streams
app.get("/sse", async (req, res) => {
  // Session Id should not exist for GET /sse requests. The session's stream
  // lives on its original response, so any other request must be finished here.
  if (req?.query?.sessionId) {
    console.error(
      "Client Reconnecting? This shouldn't happen; when client has a sessionId, GET /sse should not be called again.",
      req.query.sessionId
    );
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: GET /sse must not include a sessionId",
      },
      id: null,
    });
    return;
  }

  const { server, cleanup } = createServer();

  // Create and store transport for the new session
  const transport = new SSEServerTransport("/message", res);
  transports.set(transport.sessionId, transport);

  // Connect server to transport
  await server.connect(transport);
  const sessionId = transport.sessionId;
  console.error("Client Connected: ", sessionId);

  // Handle close of connection
  server.server.onclose = async () => {
    const sessionId = transport.sessionId;
    console.error("Client Disconnected: ", sessionId);
    transports.delete(sessionId);
    cleanup(sessionId);
  };
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
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
  }
});

// Start the express server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.error(`Server is running on port ${PORT}`);
});
