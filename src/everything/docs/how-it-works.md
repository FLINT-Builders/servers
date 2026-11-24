# Everything Server - How It Works

**[Architecture](architecture.md)
| [Project Structure](structure.md)
| [Startup Process](startup.md)
| [Server Features](features.md)
| [Extension Points](extension.md)
| How It Works**

# Conditional Tool Registration

### Module: `server/index.ts`

- Some tools require client support for the capability they demonstrate. These are:
  - `get-roots-list`
  - `trigger-elicitation-request`
  - `trigger-sampling-request`
- Client capabilities aren't known until after initilization handshake is complete.
- Most tools are registered immediately during the Server Factory execution, prior to client connection.
- To defer registration of these commands until client capabilities are known, a `registerConditionalTools(server)` function is invoked from an `onintitialized` handler.

## Resource Subscriptions

### Module: `resources/subscriptions.ts`

- Tracks subscribed URIs per server instance (one per session): `Map<McpServer, Set<uri>>`.
- Installs handlers via `setSubscriptionHandlers(server)` to process subscribe/unsubscribe requests and keep the map updated.
- Rejects URIs longer than `MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH` (2048) and new subscriptions once the process holds `MAX_RESOURCE_SUBSCRIPTIONS` (32).
- Updates are started/stopped on demand by the `toggle-subscriber-updates` tool, which calls `beginSimulatedResourceUpdates(server, sessionId)` and `stopSimulatedResourceUpdates(sessionId)`.
- `cleanup(sessionId?)` calls `stopSimulatedResourceUpdates(sessionId)` to clear intervals and `clearSubscriptions(server)` to release the session's subscriptions.

## Session‑scoped Resources

### Module: `resources/session.ts`

- `getSessionResourceURI(name: string)`: Builds a session resource URI: `demo://resource/session/<name>`.
- `registerSessionResource(server, resource, type, payload)`: Registers a resource with the given `uri`, `name`, and `mimeType`, returning a `resource_link`. The content is served from memory for the life of the session only. Supports `type: "text" | "blob"` and returns data in the corresponding field.
- Intended usage: tools can create and expose per-session artifacts without persisting them. For example, `tools/gzip-file-as-resource.ts` compresses fetched content, registers it as a session resource with `mimeType: application/gzip`, and returns either a `resource_link` or an inline `resource` based on `outputType`.

## Simulated Logging

### Module: `server/logging.ts`

- Periodically sends randomized log messages at different levels. Messages can include the session ID for clarity during demos.
- Started/stopped on demand via the `toggle-simulated-logging` tool, which calls `beginSimulatedLogging(server, sessionId?)` and `stopSimulatedLogging(sessionId?)`. Note that transport disconnect triggers `cleanup()` which also stops any active intervals.
- Uses `server.sendLoggingMessage({ level, data }, sessionId?)` so that the client’s configured minimum logging level is respected by the SDK.
