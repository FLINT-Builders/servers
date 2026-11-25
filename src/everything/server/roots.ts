import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Root,
  RootsListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Track roots by session id
export const roots: Map<string | undefined, Root[]> = new Map<
  string | undefined,
  Root[]
>();

// Limits on the client-supplied roots kept for a session
const MAX_ROOTS = 32;
const MAX_ROOT_FIELD_LENGTH = 1024;

/**
 * Copy the client's roots list into the bounded form kept for the session.
 *
 * Roots whose URI or name exceed `MAX_ROOT_FIELD_LENGTH` are dropped, at most
 * `MAX_ROOTS` roots are kept, and only the `uri` and `name` fields are copied.
 *
 * @param {Root[]} clientRoots - The roots list returned by the client.
 * @returns {Root[]} The bounded roots list.
 */
const boundRoots = (clientRoots: Root[]): Root[] =>
  clientRoots
    .filter(
      (root) =>
        root.uri.length <= MAX_ROOT_FIELD_LENGTH &&
        (root.name?.length ?? 0) <= MAX_ROOT_FIELD_LENGTH
    )
    .slice(0, MAX_ROOTS)
    .map(({ uri, name }) => (name === undefined ? { uri } : { uri, name }));

/**
 * Forget the roots list stored for a session.
 *
 * @param {string} [sessionId] - The id of the session that has ended.
 */
export const clearRoots = (sessionId?: string) => {
  roots.delete(sessionId);
};

/**
 * Get the latest the client roots list for the session.
 *
 * - Request and cache the roots list for the session if it has not been fetched before.
 * - Return the cached roots list for the session if it exists.
 *
 * When requesting the roots list for a session, it also sets up a `roots/list_changed`
 * notification handler. This ensures that updates are automatically fetched and handled
 * in real-time.
 *
 * This function is idempotent. It should only request roots from the client once per session,
 * returning the cached version thereafter.
 *
 * @param {McpServer} server - An instance of the MCP server used to communicate with the client.
 * @param {string} [sessionId] - An optional session id used to associate the roots list with a specific client session.
 *
 * @throws {Error} In case of a failure to request the roots from the client, an error log message is sent.
 */
export const syncRoots = async (server: McpServer, sessionId?: string) => {
  const clientCapabilities = server.server.getClientCapabilities() || {};
  const clientSupportsRoots: boolean = clientCapabilities?.roots !== undefined;

  // Fetch the roots list for this client
  if (clientSupportsRoots) {
    const transport = server.server.transport;

    // Function to request the updated roots list from the client
    const requestRoots = async () => {
      try {
        // Request the updated roots list from the client
        const response = await server.server.listRoots();

        // Discard a response for a session that has since closed, so it
        // cannot be stored after the session's cleanup has run
        if (!transport || server.server.transport !== transport) return;

        if (response && "roots" in response) {
          // Store the bounded roots list for this client
          const sessionRoots = boundRoots(response.roots);
          roots.set(sessionId, sessionRoots);

          const dropped = response.roots.length - sessionRoots.length;

          // Notify the client of roots received
          await server.sendLoggingMessage(
            {
              level: "info",
              logger: "everything-server",
              data:
                `Roots updated: ${response.roots.length} root(s) received from client` +
                (dropped > 0
                  ? `, ${dropped} not kept (limit ${MAX_ROOTS} roots, ${MAX_ROOT_FIELD_LENGTH} characters per URI or name)`
                  : ""),
            },
            sessionId
          );
        } else {
          await server.sendLoggingMessage(
            {
              level: "info",
              logger: "everything-server",
              data: "Client returned no roots set",
            },
            sessionId
          );
        }
      } catch (error) {
        console.error(
          `Failed to request roots from client ${sessionId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    };

    // If the roots have not been synced for this client,
    // set notification handler and request initial roots
    if (!roots.has(sessionId)) {
      // Set the list changed notification handler
      server.server.setNotificationHandler(
        RootsListChangedNotificationSchema,
        requestRoots
      );

      // Request the initial roots list immediately
      await requestRoots();
    }

    // Return the roots list for this client
    return roots.get(sessionId);
  }
};
