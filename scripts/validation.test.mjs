import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUserRecord, buildDistPayload } from "../src/validation.mjs";

const VALID = {
  $schema: "../schema/user.schema.json",
  id: "123456789012345678",
  username: "example",
  display_name: "Example",
  categories: ["scam", "phishing"],
  note: "偽のNitroプレゼント企画を装い、認証情報の入力を要求",
  status: "listed",
  username_history: ["oldname"],
  report_count: 1,
  added_at: "2026-08-21",
  updated_at: "2026-08-21",
};

test("valid record passes", () => {
  const { valid, errors } = validateUserRecord(VALID, { filename: "123456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("rejects filename/id mismatch", () => {
  const { valid, errors } = validateUserRecord(VALID, { filename: "999999999999999999.json" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("filename")));
});

test("rejects unknown keys", () => {
  const { valid, errors } = validateUserRecord({ ...VALID, evidence: ["url"] });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unknown key")));
});

test("rejects bad snowflake", () => {
  const { valid } = validateUserRecord({ ...VALID, id: "not-a-number" });
  assert.equal(valid, false);
});

test("rejects empty categories", () => {
  const { valid } = validateUserRecord({ ...VALID, categories: [] });
  assert.equal(valid, false);
});

test("rejects invalid category id", () => {
  const { valid } = validateUserRecord({ ...VALID, categories: ["scam", "not-a-category"] });
  assert.equal(valid, false);
});

test("rejects duplicate categories", () => {
  const { valid } = validateUserRecord({ ...VALID, categories: ["scam", "scam"] });
  assert.equal(valid, false);
});

test("rejects report_count < 1", () => {
  const { valid } = validateUserRecord({ ...VALID, report_count: 0 });
  assert.equal(valid, false);
});

test("rejects updated_at before added_at", () => {
  const { valid } = validateUserRecord({ ...VALID, added_at: "2026-08-21", updated_at: "2026-08-01" });
  assert.equal(valid, false);
});

test("rejects malformed JSON dates", () => {
  const { valid } = validateUserRecord({ ...VALID, added_at: "2026/08/21" });
  assert.equal(valid, false);
});

test("buildDistPayload excludes delisted from stats and users", () => {
  const delisted = { ...VALID, id: "223456789012345678", status: "delisted", report_count: 5 };
  const { users, stats } = buildDistPayload([VALID, delisted]);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, VALID.id);
  assert.equal(stats.total_listed, 1);
  assert.equal(stats.total_reports, 1);
  assert.equal(stats.by_category.scam, 1);
  assert.equal(stats.by_category.phishing, 1);
  assert.equal(stats.by_category.harassment, 0);
});
