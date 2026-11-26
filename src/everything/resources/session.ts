import {
  McpServer,
  RegisteredResource,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { Resource, ResourceLink } from "@modelcontextprotocol/sdk/types.js";

/** Longest resource name accepted for a session resource. */
export const MAX_SESSION_RESOURCE_NAME_LENGTH = 256;

/** Payload bytes retained for session resources, all sessions combined. */
export const MAX_SESSION_RESOURCE_BYTES = 8 * 1024 * 1024;

/** Session resources retained at once, all sessions combined. */
export const MAX_SESSION_RESOURCE_COUNT = 1024;

type SessionResourceEntry = {
  registeredResource: RegisteredResource;
  bytes: number;
};

/**
 * Tracks the session resources registered on each server instance, by URI, so a
 * re-registration replaces the earlier entry and the session's cleanup can remove them all.
 * Each session gets its own server, so entries never cross sessions.
 */
const sessionResources = new Map<
  McpServer,
  Map<string, SessionResourceEntry>
>();

/** Servers whose session has been cleaned up; they accept no new session resources. */
const releasedServers = new WeakSet<McpServer>();

let retainedBytes = 0;
let retainedCount = 0;

/**
 * Generates a session-scoped resource URI string based on the provided resource name.
 *
 * @param {string} name - The name of the resource to create a URI for.
 * @returns {string} The formatted session resource URI.
 */
export const getSessionResourceURI = (name: string): string => {
  return `demo://resource/session/${name}`;
};

/**
 * Registers a session-scoped resource with the provided server and returns a resource link.
 *
 * The registered resource is available during the life of the session only; it is not otherwise persisted.
 * Call `releaseSessionResources(server)` when the session ends to drop its payloads.
 *
 * @param {McpServer} server - The server instance responsible for handling the resource registration.
 * @param {Resource} resource - The resource object containing metadata such as URI, name, description, and mimeType.
 * @param {"text"|"blob"} type
 * @param payload
 * @returns {ResourceLink} An object representing the resource link, with associated metadata.
 * @throws {Error} If the session has ended, the name is too long, or retaining the payload would exceed the limits.
 */
export const registerSessionResource = (
  server: McpServer,
  resource: Resource,
  type: "text" | "blob",
  payload: string
): ResourceLink => {
  // Destructure resource
  const { uri, name, mimeType, description, title, annotations, icons, _meta } =
    resource;

  if (releasedServers.has(server)) {
    throw new Error(
      "Session has ended; session resources can no longer be registered."
    );
  }
  if (name.length > MAX_SESSION_RESOURCE_NAME_LENGTH) {
    throw new Error(
      `Session resource name exceeds ${MAX_SESSION_RESOURCE_NAME_LENGTH} characters.`
    );
  }

  const serverResources =
    sessionResources.get(server) ?? new Map<string, SessionResourceEntry>();
  const existing = serverResources.get(uri);
  const bytes = Buffer.byteLength(payload, "utf8");

  const bytesAfter = retainedBytes - (existing?.bytes ?? 0) + bytes;
  if (bytesAfter > MAX_SESSION_RESOURCE_BYTES) {
    throw new Error(
      `Session resource storage is full: retaining ${bytes} more bytes would exceed ${MAX_SESSION_RESOURCE_BYTES} bytes.`
    );
  }
  const countAfter = retainedCount - (existing ? 1 : 0) + 1;
  if (countAfter > MAX_SESSION_RESOURCE_COUNT) {
    throw new Error(
      `Session resource storage is full: at most ${MAX_SESSION_RESOURCE_COUNT} session resources can be retained.`
    );
  }

  // Prepare the resource content to return
  // See https://modelcontextprotocol.io/specification/2025-11-25/server/resources#resource-contents
  const resourceContent =
    type === "text"
      ? {
          uri: uri.toString(),
          mimeType,
          text: payload,
        }
      : {
          uri: uri.toString(),
          mimeType,
          blob: payload,
        };

  // Remove a resource previously registered at this URI in this session
  if (existing) {
    removeEntry(serverResources, uri, existing);
  }

  // Register file resource
  const registeredResource = server.registerResource(
    name,
    uri,
    { mimeType, description, title, annotations, icons, _meta },
    async () => {
      return {
        contents: [resourceContent],
      };
    }
  );

  // Track the registered resource so it can be replaced or removed with its session
  serverResources.set(uri, { registeredResource, bytes });
  sessionResources.set(server, serverResources);
  retainedBytes += bytes;
  retainedCount += 1;

  return { type: "resource_link", ...resource };
};

/**
 * Removes every session resource registered on the given server and releases its payloads.
 * The server accepts no further session resources afterwards.
 *
 * @param {McpServer} server - The server instance whose session is ending.
 */
export const releaseSessionResources = (server: McpServer): void => {
  releasedServers.add(server);
  const serverResources = sessionResources.get(server);
  if (!serverResources) return;
  for (const [uri, entry] of [...serverResources]) {
    removeEntry(serverResources, uri, entry);
  }
  sessionResources.delete(server);
};

const removeEntry = (
  serverResources: Map<string, SessionResourceEntry>,
  uri: string,
  entry: SessionResourceEntry
): void => {
  serverResources.delete(uri);
  retainedBytes -= entry.bytes;
  retainedCount -= 1;
  try {
    entry.registeredResource.remove();
  } catch (error) {
    console.error(`Failed to remove session resource ${uri}:`, error);
  }
};
