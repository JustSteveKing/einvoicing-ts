/**
 * The shapes the API sends.
 *
 * Amounts are strings throughout, because that is how the API sends them:
 * they are exact decimals, and a JavaScript number is not. Parse them with a
 * decimal library if you need arithmetic — never with `Number()`.
 */

/** One document type a participant accepts. */
export interface Capability {
  name: string;
  document_type_id: string;
  process_id: string;
}

/** A participant's optional Peppol Directory entry. */
export interface Directory {
  name: string | null;
  country_code: string | null;
}

/**
 * Whether a business can receive Peppol documents, and which ones.
 *
 * `registered: false` is an answer, not an error. And `directory: null` means
 * only that they are absent from an optional public index — the SML and SMP
 * are what decide reachability.
 */
export interface Participant {
  id: string;
  scheme: string;
  identifier: string;
  registered: boolean;
  /** Only e-invoicing types are listed, so an empty array means "cannot
   *  receive an invoice", not "not on the network". */
  capabilities: Capability[];
  directory: Directory | null;
  checked_at: string;
}

/** Where in the document a finding applies. */
export interface Location {
  xpath?: string | null;
  line?: number | null;
  path?: string | null;
}

/**
 * One thing a validator found. `message` is the official rule text, so it can
 * be quoted to whoever asks where a requirement comes from; `explanation` and
 * `fix` are this API's, in plain English.
 */
export interface Finding {
  rule_id: string;
  layer: "schema" | "en16931" | "peppol" | (string & {});
  severity: "fatal" | "error" | "warning" | (string & {});
  message: string;
  explanation: string;
  fix?: string | null;
  business_terms: string[];
  location: Location;
  docs_url: string;
}

/** How one layer of the check went. */
export interface LayerResult {
  name: string;
  status: "passed" | "failed" | "skipped" | (string & {});
}

/**
 * The outcome of validating one document.
 *
 * A document that breaks the rules is a successful request: it arrives here
 * with `valid: false`, not as a thrown error.
 */
export interface ValidationReport {
  valid: boolean;
  ruleset: { id: string; version: string };
  document: { type: string };
  layers: LayerResult[];
  summary: { errors: number; warnings: number };
  findings: Finding[];
}

/** The computed document totals, as exact decimal strings. */
export interface Totals {
  line_extension: string;
  tax_exclusive: string;
  tax: string;
  tax_inclusive: string;
  payable: string;
}

/** One VAT category and rate on the document. */
export interface VatBreakdown {
  category: string;
  rate: string;
  taxable_amount: string;
  tax_amount: string;
  exemption_reason?: string | null;
  exemption_reason_code?: string | null;
}

/**
 * A JSON invoice turned into a Peppol document. The totals and the VAT
 * breakdown were computed from the lines, and the document was validated
 * before it was returned.
 */
export interface Conversion {
  target: string;
  /** The UBL, as XML. */
  document: string;
  totals: Totals;
  vat_breakdown: VatBreakdown[];
  validation: ValidationReport;
}

/**
 * A published release of a rule set. Pin the `id` in your own configuration:
 * validating against whatever is current means a release elsewhere can turn a
 * passing build red.
 */
export interface Ruleset {
  id: string;
  name: string;
  version: string;
  status: "current" | "superseded" | "upcoming" | (string & {});
  released: string;
  mandatory_from: string;
}

/**
 * One metered thing this billing period. `overage` is what has been used
 * beyond the allowance; on a capped plan it stays zero because the requests
 * that would have caused it were refused.
 */
export interface Meter {
  used: number;
  included: number;
  overage: number;
}

/** Where the account stands this billing period. */
export interface Usage {
  plan: string;
  period_start: string;
  period_end: string;
  documents: Meter;
  lookups: Meter;
}

/** The account an API key belongs to. */
export interface Account {
  id: string;
  email: string;
  plan: string;
  created_at: string;
}

/** A key as the API will show it: the prefix, never the secret. */
export interface ApiKey {
  id: string;
  name: string;
  mode: "live" | "test";
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * A key as created, and the only time its secret exists anywhere you can read
 * it. Store it now; the API cannot show it again.
 */
export interface NewApiKey extends ApiKey {
  secret: string;
}

/** A short-lived Stripe URL to send a browser to. */
export interface BillingLink {
  url: string;
  expires_at: string | null;
}

/** The invoice shape `convert` takes. Loose on purpose: the API is the
 *  authority on what an invoice needs, and it says so in the findings. */
export interface ConversionRequest {
  target?: string;
  ruleset?: string;
  invoice: Record<string, unknown>;
}

// Helpers. Standalone functions rather than methods, so the types stay plain
// JSON that a response parses straight into, and so a bundler can drop the
// ones you do not use.

/** Does this finding make the document invalid? */
export function isError(finding: Finding): boolean {
  return finding.severity === "error" || finding.severity === "fatal";
}

/** The findings that make the document invalid. */
export function errorsIn(report: ValidationReport): Finding[] {
  return report.findings.filter(isError);
}

/** The findings that do not. */
export function warningsIn(report: ValidationReport): Finding[] {
  return report.findings.filter((finding) => !isError(finding));
}

/**
 * Does this participant accept a document type? Takes a full Peppol document
 * type identifier or any distinctive part of one, so `Invoice-2::Invoice`
 * matches without pasting the whole `urn:oasis:…` string.
 */
export function accepts(participant: Participant, documentType: string): boolean {
  return participant.capabilities.some((capability) =>
    capability.document_type_id.includes(documentType),
  );
}

/** What is left of an allowance. Derived, not something the API sends. */
export function remaining(meter: Meter): number {
  return Math.max(0, meter.included - meter.used);
}
