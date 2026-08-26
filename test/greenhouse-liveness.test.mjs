import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPosting } from "../src/verify.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "greenhouse");
const lookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

for (const [name, expected] of [
  ["live", "live"],
  ["closed", "closed"],
  ["blocked", "blocked"],
  ["inconclusive", "inconclusive"],
]) {
  test(`Greenhouse ${name} fixture is classified as ${expected}`, async () => {
    const html = fs.readFileSync(path.join(fixtures, `${name}.html`), "utf8");
    const result = await verifyPosting(`https://boards.greenhouse.io/example/jobs/${name}`, {
      lookupFn,
      fetchFn: async () => new Response(html, { status: 200 }),
    });
    assert.equal(result.status, expected);
  });
}
