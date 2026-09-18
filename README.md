# @einvoicing/sdk

TypeScript client for the [einvoicing.dev](https://www.einvoicing.dev) API:
validate, convert and look up Peppol e-invoices.

No dependencies. It uses `fetch`, so it runs on Node 20+, Bun, Deno,
Cloudflare Workers and in a browser.

```bash
npm install @einvoicing/sdk
```

## Validating

```ts
import { Einvoicing, errorsIn } from "@einvoicing/sdk";

const client = new Einvoicing({
  key: process.env.EINVOICING_API_KEY!,
  ruleset: "peppol-bis-billing-3.0.21",
});

const report = await client.validate(xml);

for (const finding of errorsIn(report)) {
  console.log(`${finding.rule_id}: ${finding.message}`);
  console.log(`  ${finding.explanation}`);
  console.log(`  ${finding.fix}`);
}
```

**An invalid document does not throw.** It resolves to a report with
`valid: false` and every finding on it — the second finding is usually the
interesting one, and an exception would only ever carry the first. Rejection
is reserved for the request failing.

Pin the ruleset. Leave it out and validation follows whatever release is
current, which means a change elsewhere can turn a passing build red without
anything of yours changing.

Each finding carries the official rule text in `message`, this API's plain
English in `explanation` and `fix`, and the layer it came from — a schema
error and a Peppol rule error are different kinds of problem.

## Converting

```ts
const conversion = await client.convert({
  invoice: {
    number: "INV-2026-0042",
    issued: "2026-09-18",
    currency: "GBP",
    // seller, buyer, lines, payment...
  },
});

await writeFile("invoice.xml", conversion.document);
```

Totals and the VAT breakdown are computed from the lines, and the result is
validated before it is returned: a conversion never hands back an invalid
document. An invoice that cannot produce one rejects with an
`InvalidInvoiceError`, whose `findings` say why.

Amounts are strings throughout, because that is how the API sends them. They
are exact decimals and a JavaScript number is not — parse them with a decimal
library, never with `Number()`.

## Looking a participant up

```ts
import { accepts } from "@einvoicing/sdk";

const participant = await client.participant("9932:GB123456789");

if (!participant.registered) {
  // Not on the network. A fact about the world, not a failure.
} else if (!accepts(participant, "Invoice-2::Invoice")) {
  // Registered, but not for invoices. A different problem, different fix.
}
```

Two traps this handles for you. A business absent from the optional Peppol
Directory (`directory` is null) may still be registered and perfectly
reachable — only the SML and SMP are authoritative. And a UK VAT number is
registered with or without its `GB` prefix, as two different participants;
the lookup tries both and reports the form that answered. Store that form.

## Account and keys

```ts
import { remaining } from "@einvoicing/sdk";

const usage = await client.usage();
remaining(usage.documents);

const key = await client.keys.create("CI", { mode: "test" });
key.secret; // The only time this exists. Store it now.

await client.keys.revoke(key.id);
await client.rulesets();
await client.account();
```

`test` keys are free, unmetered and cannot touch the account — which makes
them the right thing to put in CI.

## Errors

Every failure is an `EinvoicingError`. The API answers with RFC 9457 problem
documents, and the common ones have their own class:

| Class | When |
| --- | --- |
| `UnauthenticatedError` | The key is missing, wrong or revoked |
| `AllowanceExhaustedError` | The period's allowance is used up |
| `RateLimitedError` | Too many requests; `retryAfter` says how long |
| `NotFoundError` | No such resource |
| `InvalidInvoiceError` | A conversion could not produce a valid document; `findings` say why |
| `UnsupportedDocumentError` | That document type is not supported |
| `ProblemError` | Anything else the API reported |
| `TransportError` | The request never got an answer |
| `UnexpectedResponseError` | The API answered with something unreadable |

```ts
try {
  await client.validate(xml);
} catch (error) {
  if (error instanceof RateLimitedError) {
    await sleep((error.retryAfter ?? 5) * 1000);
  }
}
```

Branch on the class, on `error.type` or on `error.slug` — all stable. Never on
`title` or `detail`, which are prose for a human reading a log.

An `AbortError` from your own `AbortSignal` is passed through untouched,
rather than wrapped, so `signal.aborted` handling works the way you expect.

## Options

```ts
new Einvoicing({
  key,
  baseUrl: "http://localhost:8787",
  ruleset: "peppol-bis-billing-3.0.21",
  userAgent: "acme-billing/2.1",
  fetch: myInstrumentedFetch,
});
```

Every method takes an optional `{ signal }`.

## Testing

Pass a `fetch` that answers from a fixture. There is nothing else to mock —
the client holds no global state and reaches for nothing on its own.

```ts
const client = new Einvoicing({
  key: "sk_test",
  fetch: async () => new Response(JSON.stringify({ data: { valid: true } })),
});
```

The `Fetch` type is deliberately narrower than `typeof globalThis.fetch`: it
is only what this client calls, so a two-line mock satisfies it.

## Development

```bash
bun run check   # tsc --noEmit && bun test
bun run build
```

## Licence

MIT.
