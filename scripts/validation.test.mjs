import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateUserRecord,
  validateServerRecord,
  validateBotRecord,
  buildDistPayload,
  buildUserDistPayload,
  CATEGORY_IDS,
  SERVER_CATEGORY_IDS,
  BOT_CATEGORY_IDS,
  USER_LIST_FIELDS,
  SERVER_LIST_FIELDS,
  BOT_LIST_FIELDS,
} from "../src/validation.mjs";

const VALID_USER = {
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

const VALID_SERVER = {
  $schema: "../schema/server.schema.json",
  id: "223456789012345678",
  name: "Example Server",
  creator_id: "323456789012345678",
  categories: ["scam-phishing"],
  note: "偽の投資勧誘を目的としたサーバー",
  status: "listed",
  name_history: ["Old Server Name"],
  report_count: 1,
  added_at: "2026-08-21",
  updated_at: "2026-08-21",
};

const VALID_BOT = {
  $schema: "../schema/bot.schema.json",
  id: "423456789012345678",
  username: "example-bot",
  developer_id: "523456789012345678",
  categories: ["malware-token-grabber"],
  note: "招待経由でトークンを窃取するBot",
  status: "listed",
  username_history: ["old-bot-name"],
  report_count: 1,
  added_at: "2026-08-21",
  updated_at: "2026-08-21",
};

// --- user ---

test("user: valid record passes", () => {
  const { valid, errors } = validateUserRecord(VALID_USER, { filename: "123456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("user: rejects filename/id mismatch", () => {
  const { valid, errors } = validateUserRecord(VALID_USER, { filename: "999999999999999999.json" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("filename")));
});

test("user: rejects unknown keys", () => {
  const { valid, errors } = validateUserRecord({ ...VALID_USER, evidence: ["url"] });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unknown key")));
});

test("user: rejects bad snowflake", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, id: "not-a-number" });
  assert.equal(valid, false);
});

test("user: rejects empty categories", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, categories: [] });
  assert.equal(valid, false);
});

test("user: rejects invalid category id", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, categories: ["scam", "not-a-category"] });
  assert.equal(valid, false);
});

test("user: rejects duplicate categories", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, categories: ["scam", "scam"] });
  assert.equal(valid, false);
});

test("user: rejects report_count < 1", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, report_count: 0 });
  assert.equal(valid, false);
});

test("user: rejects updated_at before added_at", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, added_at: "2026-08-21", updated_at: "2026-08-01" });
  assert.equal(valid, false);
});

test("user: rejects malformed JSON dates", () => {
  const { valid } = validateUserRecord({ ...VALID_USER, added_at: "2026/08/21" });
  assert.equal(valid, false);
});

test("user: buildUserDistPayload excludes delisted from stats and users", () => {
  const delisted = { ...VALID_USER, id: "623456789012345678", status: "delisted", report_count: 5 };
  const { users, stats } = buildUserDistPayload([VALID_USER, delisted]);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, VALID_USER.id);
  assert.equal(stats.total_listed, 1);
  assert.equal(stats.total_reports, 1);
  assert.equal(stats.by_category.scam, 1);
  assert.equal(stats.by_category.phishing, 1);
  assert.equal(stats.by_category.harassment, 0);
});

test("generic buildDistPayload matches buildUserDistPayload for user data", () => {
  const { records, stats } = buildDistPayload([VALID_USER], CATEGORY_IDS, USER_LIST_FIELDS);
  const { users, stats: userStats } = buildUserDistPayload([VALID_USER]);
  assert.deepEqual(records, users);
  assert.deepEqual(stats, userStats);
});

// --- server ---

test("server: valid record passes", () => {
  const { valid, errors } = validateServerRecord(VALID_SERVER, { filename: "223456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("server: creator_id is optional", () => {
  const { creator_id, ...withoutCreator } = VALID_SERVER;
  const { valid, errors } = validateServerRecord(withoutCreator, { filename: "223456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("server: rejects invalid creator_id when present", () => {
  const { valid } = validateServerRecord({ ...VALID_SERVER, creator_id: "not-a-number" });
  assert.equal(valid, false);
});

test("server: rejects unknown keys (e.g. username)", () => {
  const { valid, errors } = validateServerRecord({ ...VALID_SERVER, username: "shouldnotexist" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unknown key")));
});

test("server: rejects invalid category id", () => {
  const { valid } = validateServerRecord({ ...VALID_SERVER, categories: ["impersonation"] });
  assert.equal(valid, false);
});

test("server: rejects name over 100 chars", () => {
  const { valid } = validateServerRecord({ ...VALID_SERVER, name: "a".repeat(101) });
  assert.equal(valid, false);
});

test("server: buildDistPayload aggregates by_category correctly", () => {
  const { records, stats } = buildDistPayload([VALID_SERVER], SERVER_CATEGORY_IDS, SERVER_LIST_FIELDS);
  assert.equal(records.length, 1);
  assert.equal(stats.by_category["scam-phishing"], 1);
  assert.equal(stats.by_category["raid-hub"], 0);
});

// --- bot ---

test("bot: valid record passes", () => {
  const { valid, errors } = validateBotRecord(VALID_BOT, { filename: "423456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("bot: developer_id is optional", () => {
  const { developer_id, ...withoutDeveloper } = VALID_BOT;
  const { valid, errors } = validateBotRecord(withoutDeveloper, { filename: "423456789012345678.json" });
  assert.equal(valid, true, errors.join("; "));
});

test("bot: rejects invalid developer_id when present", () => {
  const { valid } = validateBotRecord({ ...VALID_BOT, developer_id: "not-a-number" });
  assert.equal(valid, false);
});

test("bot: rejects unknown keys (e.g. name)", () => {
  const { valid, errors } = validateBotRecord({ ...VALID_BOT, name: "shouldnotexist" });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unknown key")));
});

test("bot: rejects invalid category id", () => {
  const { valid } = validateBotRecord({ ...VALID_BOT, categories: ["harassment"] });
  assert.equal(valid, false);
});

test("bot: buildDistPayload aggregates by_category correctly", () => {
  const { records, stats } = buildDistPayload([VALID_BOT], BOT_CATEGORY_IDS, BOT_LIST_FIELDS);
  assert.equal(records.length, 1);
  assert.equal(stats.by_category["malware-token-grabber"], 1);
  assert.equal(stats.by_category["other"], 0);
});
