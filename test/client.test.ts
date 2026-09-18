import { describe, expect, it } from "bun:test";

import {
  accepts,
  AllowanceExhaustedError,
  Einvoicing,
  errorsIn,
  InvalidInvoiceError,
  NotFoundError,
  ProblemError,
  RateLimitedError,
  remaining,
  TransportError,
  UnauthenticatedError,
  UnexpectedResponseError,
  warningsIn,
} from "../src/index.js";
import type { Fetch } from "../src/index.js";

/** A fetch that answers from a queue and keeps what it was asked. */
function fakeFetch(...responses: Response[]) {
  const requests: Request[] = [];

  const fetch: Fetch = async (input, init) => {
    requests.push(new Request(input, init));

    return responses.shift() ?? new Response('{"data":{}}', { status: 200 });
  };

  return { fetch, requests, last: () => requests[requests.length - 1]! };
}

function data(body: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data: body }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function problem(
  slug: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://www.einvoicing.dev/problems/${slug}`,
      title: "It went wrong.",
      status,
      ...extra,
    }),
    { status, headers: { "content-type": "application/problem+json", ...headers } },
  );
}

function client(fetch: Fetch, options = {}) {
  return new Einvoicing({ key: "sk_test_example", fetch, ...options });
}

describe("validate", () => {
  it("sends the document as XML and reads the report back", async () => {
    const http = fakeFetch(
      data({
        valid: false,
        ruleset: { id: "peppol-bis-billing-3.0.21", version: "3.0.21" },
        summary: { errors: 1, warnings: 1 },
        findings: [
          {
            rule_id: "PEPPOL-EN16931-R003",
            layer: "peppol",
            severity: "error",
            message: "A buyer reference or purchase order reference MUST be provided.",
            fix: "Set BT-10 or BT-13.",
            business_terms: ["BT-10", "BT-13"],
          },
          {
            rule_id: "PEPPOL-EN16931-R110",
            layer: "peppol",
            severity: "warning",
            message: "Start date should be before end date.",
          },
        ],
      }),
    );

    const report = await client(http.fetch).validate("<Invoice/>");

    const request = http.last();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.einvoicing.dev/v1/validations");
    expect(request.headers.get("content-type")).toBe("application/xml");
    expect(request.headers.get("authorization")).toBe("Bearer sk_test_example");
    expect(request.headers.get("user-agent")).toStartWith("einvoicing-ts/");
    expect(await request.text()).toBe("<Invoice/>");

    // An invalid document is an answer, not a rejection.
    expect(report.valid).toBe(false);
    expect(errorsIn(report)).toHaveLength(1);
    expect(warningsIn(report)).toHaveLength(1);
    expect(errorsIn(report)[0]!.business_terms).toEqual(["BT-10", "BT-13"]);
  });

  it("pins the configured ruleset", async () => {
    const http = fakeFetch(data({ valid: true }));

    await client(http.fetch, { ruleset: "peppol-bis-billing-3.0.21" }).validate("<Invoice/>");

    expect(http.last().url).toBe(
      "https://api.einvoicing.dev/v1/validations?ruleset=peppol-bis-billing-3.0.21",
    );
  });

  it("lets the call override the client's ruleset", async () => {
    const http = fakeFetch(data({ valid: true }));

    await client(http.fetch, { ruleset: "3.0.21" }).validate("<Invoice/>", {
      ruleset: "3.0.20",
    });

    expect(http.last().url).toEndWith("ruleset=3.0.20");
  });

  it("prefixes the user agent when asked", async () => {
    const http = fakeFetch(data({ valid: true }));

    await client(http.fetch, { userAgent: "acme-billing/2.1" }).validate("<Invoice/>");

    expect(http.last().headers.get("user-agent")).toStartWith("acme-billing/2.1 ");
  });
});

describe("convert", () => {
  it("defaults the target and sends the invoice", async () => {
    const http = fakeFetch(
      data({
        target: "peppol-bis-billing-3",
        document: "<?xml version='1.0'?><Invoice/>",
        totals: { payable: "1200.00" },
        vat_breakdown: [{ category: "S", rate: "20.00" }],
        validation: { valid: true, findings: [] },
      }),
    );

    const conversion = await client(http.fetch).convert({ invoice: { number: "INV-1" } });

    expect(await http.last().json()).toEqual({
      target: "peppol-bis-billing-3",
      invoice: { number: "INV-1" },
    });
    expect(conversion.validation.valid).toBe(true);
    // Amounts stay strings: they are exact decimals and a number is not.
    expect(conversion.totals.payable).toBe("1200.00");
  });

  it("carries the findings on an invoice it could not convert", async () => {
    const http = fakeFetch(
      problem("invalid-invoice", 422, {
        findings: [{ rule_id: "BR-CO-10", severity: "error", message: "Totals disagree." }],
      }),
    );

    const failure = client(http.fetch).convert({ invoice: {} });

    await expect(failure).rejects.toBeInstanceOf(InvalidInvoiceError);
    await failure.catch((error: InvalidInvoiceError) => {
      expect(error.findings).toHaveLength(1);
      expect(error.findings[0]!.rule_id).toBe("BR-CO-10");
    });
  });
});

describe("participants", () => {
  it("escapes the identifier and reads the answer", async () => {
    const http = fakeFetch(
      data({
        id: "9932:gb123456789",
        scheme: "9932",
        identifier: "gb123456789",
        registered: true,
        capabilities: [
          {
            name: "Peppol BIS Billing 3.0 Invoice",
            document_type_id:
              "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:cen.eu",
            process_id: "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0",
          },
        ],
        directory: null,
        checked_at: "2026-09-18T09:00:00.000Z",
      }),
    );

    const participant = await client(http.fetch).participant("9932:GB123456789");

    expect(http.last().url).toBe(
      "https://api.einvoicing.dev/v1/participants/9932%3AGB123456789",
    );
    expect(participant.registered).toBe(true);
    // The network lower-cases identifiers; that is normal, not mangling.
    expect(participant.identifier).toBe("gb123456789");
    // Absent from the optional directory says nothing about reachability.
    expect(participant.directory).toBeNull();
    expect(accepts(participant, "Invoice-2::Invoice")).toBe(true);
    expect(accepts(participant, "CreditNote-2::CreditNote")).toBe(false);
  });

  it("treats an unregistered business as an answer", async () => {
    const http = fakeFetch(data({ registered: false, capabilities: [] }));

    const participant = await client(http.fetch).participant("9932:GB999999999");

    expect(participant.registered).toBe(false);
  });

  it("still rejects when the identifier is not a thing", async () => {
    const http = fakeFetch(problem("not-found", 404));

    await expect(client(http.fetch).participant("nonsense")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("account", () => {
  it("works out what is left, which the API does not send", async () => {
    const http = fakeFetch(
      data({
        plan: "developer",
        documents: { included: 1000, used: 250, overage: 0 },
        lookups: { included: 500, used: 620, overage: 120 },
      }),
    );

    const usage = await client(http.fetch).usage();

    expect(remaining(usage.documents)).toBe(750);
    expect(remaining(usage.lookups)).toBe(0);
    expect(usage.lookups.overage).toBe(120);
  });

  it("creates a key and hands back the secret once", async () => {
    const http = fakeFetch(data({ id: "01K5", mode: "test", secret: "sk_test_secret" }));

    const key = await client(http.fetch).keys.create("CI", {
      mode: "test",
      expiresAt: "2026-12-18T00:00:00.000Z",
    });

    expect(await http.last().json()).toEqual({
      name: "CI",
      mode: "test",
      expires_at: "2026-12-18T00:00:00.000Z",
    });
    expect(key.secret).toBe("sk_test_secret");
  });

  it("revokes a key without expecting a body back", async () => {
    const http = fakeFetch(new Response(null, { status: 204 }));

    await client(http.fetch).keys.revoke("01K5");

    expect(http.last().method).toBe("DELETE");
    expect(http.last().url).toBe("https://api.einvoicing.dev/v1/keys/01K5");
  });

  it("opens a billing session", async () => {
    const http = fakeFetch(data({ url: "https://billing.stripe.com/x", expires_at: null }));

    const link = await client(http.fetch).billing.checkout("pro");

    expect(link.url).toStartWith("https://billing.stripe.com/");
    expect(await http.last().json()).toEqual({ plan: "pro" });
  });
});

describe("errors", () => {
  it("throws the right class for each problem", async () => {
    const cases: [string, number, new (...args: never[]) => ProblemError][] = [
      ["unauthenticated", 401, UnauthenticatedError],
      ["allowance-exhausted", 402, AllowanceExhaustedError],
      ["rate-limited", 429, RateLimitedError],
      ["not-found", 404, NotFoundError],
    ];

    for (const [slug, status, expected] of cases) {
      const http = fakeFetch(problem(slug, status));
      const failure = client(http.fetch).usage();

      await expect(failure).rejects.toBeInstanceOf(expected);
      await failure.catch((error: ProblemError) => {
        expect(error.slug).toBe(slug);
        expect(error.status).toBe(status);
      });
    }
  });

  it("falls back to a plain problem for a type it does not know", async () => {
    const http = fakeFetch(problem("some-new-thing", 418));

    const failure = client(http.fetch).usage();

    await expect(failure).rejects.toBeInstanceOf(ProblemError);
    await failure.catch((error: ProblemError) => {
      expect(error.constructor.name).toBe("ProblemError");
      expect(error.slug).toBe("some-new-thing");
    });
  });

  it("reads retry-after from the header when the body is silent", async () => {
    const http = fakeFetch(problem("rate-limited", 429, {}, { "retry-after": "30" }));

    const failure = client(http.fetch).usage();

    await failure.catch((error: RateLimitedError) => {
      expect(error.retryAfter).toBe(30);
    });
    await expect(failure).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("keeps the real status when the body has none", async () => {
    const http = fakeFetch(new Response("", { status: 500 }));

    const failure = client(http.fetch).usage();

    await failure.catch((error: ProblemError) => {
      expect(error.status).toBe(500);
      expect(error.message).toBe("The API answered 500.");
    });
    await expect(failure).rejects.toBeInstanceOf(ProblemError);
  });

  it("says so when the answer is not JSON", async () => {
    const http = fakeFetch(new Response("<html>gateway</html>", { status: 200 }));

    await expect(client(http.fetch).usage()).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("wraps a transport failure", async () => {
    const fetch: Fetch = () => Promise.reject(new Error("ECONNREFUSED"));

    await expect(client(fetch).usage()).rejects.toBeInstanceOf(TransportError);
  });

  it("hands an abort back as it is", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetch: Fetch = () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    };

    await expect(
      client(fetch).usage({ signal: controller.signal }),
    ).rejects.toThrow("aborted");
  });
});
