import { expect, it } from "bun:test";

import packageJson from "../package.json" with { type: "json" };
import { VERSION } from "../src/index.js";

it("reports the version the package actually ships", () => {
  // The PHP SDK spent four releases telling every request it was 0.1.0,
  // because nothing checked. This is that check.
  expect(VERSION).toBe(packageJson.version);
});
