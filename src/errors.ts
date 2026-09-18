import type { Finding } from "./types.js";

/** Everything this package throws. */
export class EinvoicingError extends Error {
  override readonly name: string = "EinvoicingError";
}

/** The request never got an answer: DNS, TLS, a timeout, an abort. */
export class TransportError extends EinvoicingError {
  override readonly name = "TransportError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The API answered, with something this client cannot read. */
export class UnexpectedResponseError extends EinvoicingError {
  override readonly name = "UnexpectedResponseError";

  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/**
 * An RFC 9457 problem the API reported.
 *
 * Branch on `type` or `slug`, which are stable. Never on `title` or `detail`:
 * those are prose written for a human reading a log, and they change.
 */
export class ProblemError extends EinvoicingError {
  override readonly name: string = "ProblemError";

  constructor(
    readonly type: string,
    readonly title: string,
    readonly status: number,
    readonly detail: string | null,
    /** Everything the problem carried, extensions included. */
    readonly members: Record<string, unknown>,
  ) {
    super(detail === null ? title : `${title} ${detail}`);
  }

  /** The last segment of the type URI, such as `rate-limited`. */
  get slug(): string {
    const path = this.type.split("?")[0] ?? this.type;
    return path.slice(path.lastIndexOf("/") + 1);
  }
}

/** The key is missing, wrong or revoked. */
export class UnauthenticatedError extends ProblemError {
  override readonly name = "UnauthenticatedError";
}

/** This period's allowance is used up. */
export class AllowanceExhaustedError extends ProblemError {
  override readonly name = "AllowanceExhaustedError";
}

/** Too many requests. */
export class RateLimitedError extends ProblemError {
  override readonly name = "RateLimitedError";

  /** How long to wait, in seconds, or null when the API did not say. */
  get retryAfter(): number | null {
    const value = this.members["retry_after"];
    const seconds = typeof value === "string" ? Number.parseInt(value, 10) : value;

    return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? seconds
      : null;
  }
}

/** No such resource. */
export class NotFoundError extends ProblemError {
  override readonly name = "NotFoundError";
}

/** That document type is not supported. */
export class UnsupportedDocumentError extends ProblemError {
  override readonly name = "UnsupportedDocumentError";
}

/**
 * A conversion could not produce a valid document. The findings say why, in
 * the same shape validation returns them.
 *
 * Conversion only. Validating a document that breaks the rules is a success:
 * it answers with a report whose `valid` is false.
 */
export class InvalidInvoiceError extends ProblemError {
  override readonly name = "InvalidInvoiceError";

  get findings(): Finding[] {
    const findings = this.members["findings"];
    return Array.isArray(findings) ? (findings as Finding[]) : [];
  }
}

type ProblemConstructor = new (
  type: string,
  title: string,
  status: number,
  detail: string | null,
  members: Record<string, unknown>,
) => ProblemError;

const classes: Record<string, ProblemConstructor> = {
  unauthenticated: UnauthenticatedError,
  "allowance-exhausted": AllowanceExhaustedError,
  "rate-limited": RateLimitedError,
  "not-found": NotFoundError,
  "invalid-invoice": InvalidInvoiceError,
  "unsupported-document": UnsupportedDocumentError,
};

/** Build the right error for a problem body. */
export function problemFrom(
  body: Record<string, unknown>,
  status: number,
  retryAfter: string | null,
): ProblemError {
  const type = typeof body["type"] === "string" ? body["type"] : "about:blank";
  const title =
    typeof body["title"] === "string" ? body["title"] : `The API answered ${status}.`;
  const detail = typeof body["detail"] === "string" ? body["detail"] : null;

  // The body repeats the status, but the response is what actually happened:
  // a truncated or unexpected body must not blank it.
  const reported = typeof body["status"] === "number" ? body["status"] : status;

  const members = { ...body };
  if (retryAfter !== null && members["retry_after"] === undefined) {
    members["retry_after"] = retryAfter;
  }

  const slug = type.slice(type.lastIndexOf("/") + 1);
  const Problem = classes[slug] ?? ProblemError;

  return new Problem(type, title, reported, detail, members);
}
