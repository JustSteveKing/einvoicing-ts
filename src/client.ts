import {
  problemFrom,
  TransportError,
  UnexpectedResponseError,
} from "./errors.js";
import type {
  Account,
  ApiKey,
  BillingLink,
  Conversion,
  ConversionRequest,
  NewApiKey,
  Participant,
  Ruleset,
  Usage,
  ValidationReport,
} from "./types.js";

/** The production API. */
export const DEFAULT_BASE_URL = "https://api.einvoicing.dev";

/** This client's version, sent in the User-Agent. */
export const VERSION = "0.1.1";

/**
 * Just the part of fetch this client uses.
 *
 * Deliberately narrower than `typeof globalThis.fetch`, which carries
 * runtime-specific extras such as `preconnect` that nobody writing a mock
 * should have to implement.
 */
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EinvoicingOptions {
  /** Your API key. Test keys are free, unmetered and cannot touch the
   *  account, which makes them the right thing to put in CI. */
  key: string;
  /** Somewhere else to point, such as a local instance. */
  baseUrl?: string;
  /**
   * Pin validation to a published release, such as
   * `peppol-bis-billing-3.0.21`, instead of following whatever is current.
   */
  ruleset?: string;
  /** Your own fetch: a mock, an instrumented one, an undici Agent. */
  fetch?: Fetch;
  /** Sent after this client's own identifier. Worth setting if you ever want
   *  support to find your requests. */
  userAgent?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ValidateOptions extends RequestOptions {
  /** Overrides the client's ruleset for this call. */
  ruleset?: string;
}

/**
 * The einvoicing.dev API.
 *
 * ```ts
 * const client = new Einvoicing({ key: process.env.EINVOICING_API_KEY! });
 * const report = await client.validate(xml);
 * ```
 *
 * A document that breaks the rules does not throw. It comes back as a report
 * with `valid: false` and every finding on it, because the second finding is
 * usually the interesting one. Throwing is reserved for the request failing.
 */
export class Einvoicing {
  readonly #key: string;
  readonly #baseUrl: string;
  readonly #ruleset: string | undefined;
  readonly #fetch: Fetch;
  readonly #userAgent: string;

  constructor(options: EinvoicingOptions) {
    this.#key = options.key;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#ruleset = options.ruleset;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#userAgent = options.userAgent
      ? `${options.userAgent} einvoicing-ts/${VERSION}`
      : `einvoicing-ts/${VERSION}`;
  }

  /**
   * Validate a UBL 2.1 Invoice or CreditNote.
   *
   * An invalid document resolves, it does not reject: the report says so, and
   * carries every finding.
   */
  async validate(document: string, options: ValidateOptions = {}): Promise<ValidationReport> {
    const ruleset = options.ruleset ?? this.#ruleset;

    return this.#send<ValidationReport>("POST", "/v1/validations", {
      body: document,
      contentType: "application/xml",
      query: ruleset === undefined ? {} : { ruleset },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * Turn your own invoice data into a Peppol document.
   *
   * An invoice that cannot produce a valid document rejects with an
   * `InvalidInvoiceError`, whose `findings` say why.
   */
  async convert(
    request: ConversionRequest,
    options: RequestOptions = {},
  ): Promise<Conversion> {
    const body = { target: "peppol-bis-billing-3", ...request };
    if (body.ruleset === undefined && this.#ruleset !== undefined) {
      body.ruleset = this.#ruleset;
    }

    return this.#send<Conversion>("POST", "/v1/conversions", {
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /**
   * Ask the network whether a business can receive, and what. The id is a
   * scheme and a value, such as `9932:GB123456789`.
   */
  async participant(id: string, options: RequestOptions = {}): Promise<Participant> {
    return this.#send<Participant>(
      "GET",
      `/v1/participants/${encodeURIComponent(id)}`,
      options,
    );
  }

  /** Every supported rule set, newest first. */
  async rulesets(options: RequestOptions = {}): Promise<Ruleset[]> {
    return this.#send<Ruleset[]>("GET", "/v1/rulesets", options);
  }

  /** Where the account stands this billing period. */
  async usage(options: RequestOptions = {}): Promise<Usage> {
    return this.#send<Usage>("GET", "/v1/usage", options);
  }

  /** The account the key belongs to. */
  async account(options: RequestOptions = {}): Promise<Account> {
    return this.#send<Account>("GET", "/v1/account", options);
  }

  readonly keys = {
    list: (options: RequestOptions = {}): Promise<ApiKey[]> =>
      this.#send<ApiKey[]>("GET", "/v1/keys", options),

    /**
     * Create a key. The secret on the result is the only copy that will ever
     * exist — store it now.
     */
    create: (
      name: string,
      init: { mode?: "live" | "test"; expiresAt?: string } & RequestOptions = {},
    ): Promise<NewApiKey> => {
      const body: Record<string, unknown> = { name, mode: init.mode ?? "live" };
      if (init.expiresAt !== undefined) body["expires_at"] = init.expiresAt;

      return this.#send<NewApiKey>("POST", "/v1/keys", {
        body: JSON.stringify(body),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    },

    /** Revoke a key. It stops working immediately, and there is no undo. */
    revoke: async (id: string, options: RequestOptions = {}): Promise<void> => {
      await this.#send<null>("DELETE", `/v1/keys/${encodeURIComponent(id)}`, options);
    },
  };

  readonly billing = {
    /** Start a paid plan. */
    checkout: (
      plan: "developer" | "pro",
      options: RequestOptions = {},
    ): Promise<BillingLink> =>
      this.#send<BillingLink>("POST", "/v1/billing/checkout-sessions", {
        body: JSON.stringify({ plan }),
        ...(options.signal ? { signal: options.signal } : {}),
      }),

    /** Open the billing portal. */
    portal: (options: RequestOptions = {}): Promise<BillingLink> =>
      this.#send<BillingLink>("POST", "/v1/billing/portal-sessions", options),
  };

  async #send<T>(
    method: string,
    path: string,
    init: {
      body?: string;
      contentType?: string;
      query?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const url = new URL(this.#baseUrl + path);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      url.searchParams.set(name, value);
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.#key}`,
      "user-agent": this.#userAgent,
    };
    if (init.body !== undefined) {
      headers["content-type"] = init.contentType ?? "application/json";
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (cause) {
      // An abort is the caller's own doing; hand it back as it is.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;

      throw new TransportError(
        `The request to ${url.href} could not be sent.`,
        { cause },
      );
    }

    const text = await response.text();
    const body = text === "" ? {} : parse(text, response.status);

    if (!response.ok) {
      throw problemFrom(body, response.status, response.headers.get("retry-after"));
    }

    // 204, and anything else with nothing to say.
    if (text === "") return null as T;

    if (!("data" in body)) {
      throw new UnexpectedResponseError(
        "The API returned a response this client does not understand.",
        response.status,
        text,
      );
    }

    return body["data"] as T;
  }
}

function parse(text: string, status: number): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("not an object");
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new UnexpectedResponseError(
      `The API answered ${status} with a body that is not JSON.`,
      status,
      text,
    );
  }
}
