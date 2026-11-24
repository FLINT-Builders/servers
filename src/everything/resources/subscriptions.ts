import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Maximum number of (session, URI) subscriptions held by the process at once
export const MAX_RESOURCE_SUBSCRIPTIONS = 32;

// Maximum accepted length of a subscribed URI, in UTF-16 code units
export const MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH = 2048;

// Track subscribed URIs by server instance (one server per client session)
const subscriptions: Map<McpServer, Set<string>> = new Map<
  McpServer,
  Set<string>
>();

// Total number of entries across all sets in `subscriptions`
let subscriptionCount = 0;

// Servers whose session has ended; they may not add subscriptions again
const closedServers: WeakSet<McpServer> = new WeakSet<McpServer>();

// Interval to send notifications to subscribers
const subsUpdateIntervals: Map<string | undefined, NodeJS.Timeout | undefined> =
  new Map<string | undefined, NodeJS.Timeout | undefined>();

/**
 * Sets up the subscription and unsubscription handlers for the provided server.
 *
 * The function defines two request handlers:
 * 1. A `Subscribe` handler that allows clients to subscribe to specific resource URIs.
 * 2. An `Unsubscribe` handler that allows clients to unsubscribe from specific resource URIs.
 *
 * The `Subscribe` handler performs the following actions:
 * - Rejects URIs longer than `MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH`.
 * - Rejects new subscriptions once `MAX_RESOURCE_SUBSCRIPTIONS` are held.
 * - Records the URI for this server's session.
 * - Logs a message acknowledging the subscription request.
 *
 * The `Unsubscribe` handler performs the following actions:
 * - Removes the URI from this server's session.
 * - Logs a message acknowledging the unsubscription request.
 *
 * Subscriptions are released by `clearSubscriptions(server)` when the session ends.
 *
 * @param {McpServer} server - The server instance to which subscription handlers will be attached.
 */
export const setSubscriptionHandlers = (server: McpServer) => {
  // Set the subscription handler
  server.server.setRequestHandler(
    SubscribeRequestSchema,
    async (request, extra) => {
      // Get the URI to subscribe to
      const { uri } = request.params;

      // Get the session id (can be undefined for stdio)
      const sessionId = extra.sessionId as string;

      if (closedServers.has(server)) {
        throw new McpError(ErrorCode.InvalidRequest, "Session has ended");
      }

      if (uri.length > MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Resource URI exceeds ${MAX_RESOURCE_SUBSCRIPTION_URI_LENGTH} characters`
        );
      }

      // Record the subscription before any await so concurrent requests
      // cannot all pass the limit check
      let uris = subscriptions.get(server);
      if (!uris?.has(uri)) {
        if (subscriptionCount >= MAX_RESOURCE_SUBSCRIPTIONS) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Resource subscription limit of ${MAX_RESOURCE_SUBSCRIPTIONS} reached`
          );
        }
        if (!uris) {
          uris = new Set<string>();
          subscriptions.set(server, uris);
        }
        uris.add(uri);
        subscriptionCount++;
      }

      // Acknowledge the subscribe request
      await server.sendLoggingMessage(
        {
          level: "info",
          data: `Received Subscribe Resource request for URI: ${uri} ${
            sessionId ? `from session ${sessionId}` : ""
          }`,
        },
        sessionId
      );

      return {};
    }
  );

  // Set the unsubscription handler
  server.server.setRequestHandler(
    UnsubscribeRequestSchema,
    async (request, extra) => {
      // Get the URI to unsubscribe from
      const { uri } = request.params;

      // Get the session id (can be undefined for stdio)
      const sessionId = extra.sessionId as string;

      // Remove the subscription
      const uris = subscriptions.get(server);
      if (uris?.delete(uri)) {
        subscriptionCount--;
        if (uris.size === 0) subscriptions.delete(server);
      }

      // Acknowledge the unsubscribe request
      await server.sendLoggingMessage(
        {
          level: "info",
          data: `Received Unsubscribe Resource request: ${uri} ${
            sessionId ? `from session ${sessionId}` : ""
          }`,
        },
        sessionId
      );
      return {};
    }
  );
};

/**
 * Releases every subscription held by the given server and prevents it from
 * subscribing again. Call when the server's session ends.
 *
 * @param {McpServer} server - The server instance whose session has ended.
 */
export const clearSubscriptions = (server: McpServer) => {
  closedServers.add(server);
  const uris = subscriptions.get(server);
  if (uris) {
    subscriptionCount -= uris.size;
    subscriptions.delete(server);
  }
};

/**
 * Sends simulated resource update notifications to the subscribed client.
 *
 * Emits a `notifications/resources/updated` notification for each URI the
 * given server's client is subscribed to.
 *
 * @param {McpServer} server - The server instance used to send notifications.
 * @returns {Promise<void>} Resolves once all applicable notifications are sent.
 */
const sendSimulatedResourceUpdates = async (
  server: McpServer
): Promise<void> => {
  const uris = subscriptions.get(server);
  if (!uris) return;
  for (const uri of [...uris]) {
    await server.server.notification({
      method: "notifications/resources/updated",
      params: { uri },
    });
  }
};

/**
 * Starts the process of simulating resource updates and sending server notifications
 * to the client for the resources they are subscribed to. If the update interval is
 * already active, invoking this function will not start another interval.
 *
 * @param server
 * @param sessionId
 */
export const beginSimulatedResourceUpdates = (
  server: McpServer,
  sessionId: string | undefined
) => {
  if (closedServers.has(server)) return;
  if (!subsUpdateIntervals.has(sessionId)) {
    // Send once immediately
    sendSimulatedResourceUpdates(server);

    // Set the interval to send later resource update notifications to this client
    subsUpdateIntervals.set(
      sessionId,
      setInterval(() => sendSimulatedResourceUpdates(server), 5000)
    );
  }
};

/**
 * Reports whether simulated resource updates are active for a given session.
 *
 * @param {string} [sessionId]
 * @returns {boolean}
 */
export const isSimulatingResourceUpdates = (sessionId?: string): boolean =>
  subsUpdateIntervals.has(sessionId);

/**
 * Stops simulated resource updates for a given session.
 *
 * This function halts any active intervals associated with the provided session ID.
 * Session ID can be undefined for stdio.
 *
 * @param {string} [sessionId]
 */
export const stopSimulatedResourceUpdates = (sessionId?: string) => {
  // Remove active intervals
  if (subsUpdateIntervals.has(sessionId)) {
    const subsUpdateInterval = subsUpdateIntervals.get(sessionId);
    clearInterval(subsUpdateInterval);
    subsUpdateIntervals.delete(sessionId);
  }
};
