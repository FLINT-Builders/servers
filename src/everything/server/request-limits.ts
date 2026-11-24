import express, { NextFunction, Request, Response } from "express";

/** Largest request body, in bytes, accepted for one client POST. */
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Largest combined number of array elements and object members accepted in one
 * client POST body. The SDK validates every element of an incoming message,
 * including client results such as `roots/list` and elicitation replies, with no
 * bound of its own; a body under MAX_REQUEST_BODY_BYTES can hold enough elements
 * for that validation to exhaust the heap.
 */
export const MAX_REQUEST_ELEMENTS = 10_000;

/**
 * Whether `value` contains more than `max` array elements and object members in
 * total. Walks iteratively and stops as soon as the count passes `max`.
 */
export function exceedsElementLimit(value: unknown, max: number): boolean {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > max) return true;
        if (child !== null && typeof child === "object") stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.hasOwn(node, key)) continue;
        if (++count > max) return true;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === "object") stack.push(child);
      }
    }
  }
  return false;
}

function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

// Parses regardless of Content-Type so no body reaches a transport unchecked;
// the transports still reject non-JSON content types themselves.
const parseJsonBody = express.json({
  limit: MAX_REQUEST_BODY_BYTES,
  type: () => true,
});

/**
 * Express middleware for routes that hand client messages to an SDK transport.
 * Parses the body under MAX_REQUEST_BODY_BYTES and rejects it when it holds more
 * than MAX_REQUEST_ELEMENTS elements, before the SDK validates anything. Pass
 * `req.body` on to the transport as its pre-parsed body.
 */
export function boundedJsonBody(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  parseJsonBody(req, res, (error?: unknown) => {
    if (error) {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : 400;
      if (status === 413) {
        sendJsonRpcError(
          res,
          413,
          -32000,
          `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`
        );
      } else if (status === 415) {
        sendJsonRpcError(
          res,
          415,
          -32000,
          "Unsupported Media Type: request body charset or encoding"
        );
      } else {
        sendJsonRpcError(res, 400, -32700, "Parse error: Invalid JSON");
      }
      return;
    }
    if (exceedsElementLimit(req.body, MAX_REQUEST_ELEMENTS)) {
      sendJsonRpcError(
        res,
        413,
        -32000,
        `Request body exceeds ${MAX_REQUEST_ELEMENTS} array elements and object members`
      );
      return;
    }
    next();
  });
}
