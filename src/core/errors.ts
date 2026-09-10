/** What a log line may carry of an error: its identity, never its payload. */
export interface DescribedError {
  name: string;
  message: string;
  stack?: string;
  cause?: DescribedError;
  /** An AggregateError's members, the first few. */
  errors?: DescribedError[];
}

/**
 * What a failure is allowed to leave in the log: the error's class, its
 * message, where it was thrown, and the same for the error that caused it —
 * a `fetch failed` says nothing without its ENOTFOUND underneath. Not the
 * object itself: the AI SDK's APICallError carries the request body it sent,
 * which is the person's own resolve_media query; a `pg` error carries
 * `detail` with row values; and pino's error serializer would copy every
 * such enumerable field into the line.
 *
 * undici wraps a multi-address connect failure (any dual-stack host, anything
 * behind a CDN) in an AggregateError with an empty message and the detail in
 * `errors`, so those are walked too, as a list of causes.
 *
 * Runs inside a tool's catch, so it must not throw itself: `String()` of a
 * prototype-less object does (there is no toString to call), and would turn
 * a handled failure into an MCP internal error.
 */
export function describeError(error: unknown, depth = 0): DescribedError {
  if (error instanceof Error) {
    const described: DescribedError = { name: error.name, message: error.message, stack: error.stack };
    if (depth < 3) {
      if (error instanceof AggregateError && error.errors.length > 0) {
        described.errors = error.errors.slice(0, 5).map((inner) => describeError(inner, depth + 1));
      }
      if (error.cause !== undefined) described.cause = describeError(error.cause, depth + 1);
    }
    return described;
  }
  let message: string;
  try {
    message = typeof error === "string" ? error : String(error);
  } catch {
    message = "an error that could not be printed";
  }
  return { name: "Error", message };
}
