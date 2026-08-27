/**
 * users/<discordID>.json / servers/<guildID>.json / bots/<botID>.json のバリデーションロジック。
 *
 * なぜAjv等のJSON Schemaライブラリを使わず手書きなのか:
 * Cloudflare Workersはデフォルトで `eval` / `new Function` を許可しない。
 * AjvはデフォルトでスキーマからJSをコード生成して`new Function`で実行するため、
 * Workers上でそのまま使うと実行時エラーになる（standaloneコード生成モードを使えば
 * 回避できるが、ビルドステップが増える）。
 *
 * このプロジェクトは「Worker側の事前検証（コミット前のゲート）」と
 * 「CI側の事後検証（監査・保険）」の両方で*同一のロジック*を使うことが重要
 * （PRレビュー工程を設けない設計のため、Workerの検証が事実上唯一の関所になる）。
 * そのため依存ゼロ・eval不使用のプレーンなESMモジュールとして実装し、
 * Node（CI）にもWorkers（本番）にもそのままimportできる形にしている。
 *
 * このファイルはWorker側リポジトリからは
 *   npm install github:OWNER/REPO
 * のような形でこのリポジトリ自体を依存として取り込み、
 *   import { validateUserRecord } from "xgomi-discord/src/validation.mjs"
 * のように参照する想定（package.json参照）。
 * 「スキーマは書いたが実装は別物」という二重管理を避けるため、
 * schema/*.json はドキュメント・エディタ補完用、
 * 実行時の正はこのファイルという役割分担にしている。
 *
 * user/server/botの3種は対象の性質が違う（人間アカウント/サーバー/Botアカウント）ため
 * カテゴリ体系・スキーマは分離しつつ、検証・集計の骨組みは共通化している。
 *
 * malicious-server-creator / malicious-bot-developer は、悪質サーバー/Bot通報の承認時に
 * 作成者/開発者IDをuser側へ自動登録するために追加したカテゴリ（通常の通報フローからも
 * 選択可能）。
 */

export const CATEGORY_IDS = Object.freeze([
  "scam",
  "phishing",
  "impersonation",
  "raid-spam",
  "bad-solicitation",
  "harassment",
  "doxxing",
  "hate-speech",
  "bot-abuse",
  "malicious-server-creator",
  "malicious-bot-developer",
  "other",
]);

export const SERVER_CATEGORY_IDS = Object.freeze([
  "scam-phishing",
  "illegal-tos-content",
  "raid-hub",
  "other",
]);

export const BOT_CATEGORY_IDS = Object.freeze([
  "malware-token-grabber",
  "raid-spam",
  "scam-phishing",
  "impersonation",
  "data-harvesting",
  "other",
]);

export const STATUS_VALUES = Object.freeze(["listed", "delisted"]);

export const ALLOWED_KEYS = Object.freeze([
  "$schema",
  "id",
  "username",
  "display_name",
  "categories",
  "note",
  "status",
  "username_history",
  "report_count",
  "added_at",
  "updated_at",
]);

export const SERVER_ALLOWED_KEYS = Object.freeze([
  "$schema",
  "id",
  "name",
  "creator_id",
  "categories",
  "note",
  "status",
  "name_history",
  "report_count",
  "added_at",
  "updated_at",
]);

export const BOT_ALLOWED_KEYS = Object.freeze([
  "$schema",
  "id",
  "username",
  "developer_id",
  "categories",
  "note",
  "status",
  "username_history",
  "report_count",
  "added_at",
  "updated_at",
]);

const SNOWFLAKE_RE = /^[0-9]{17,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX_LENGTH = 1000;
const NAME_MAX_LENGTH = 32;
const SERVER_NAME_MAX_LENGTH = 100;
const USERNAME_HISTORY_MAX_ITEMS = 50;

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors  空なら valid===true
 */

/**
 * added_at/updated_at/report_countなど、3種で共通の末尾フィールドを検証する。
 * @param {Record<string, unknown>} record
 * @param {(msg: string) => void} push
 */
function validateCommonTailFields(record, push) {
  if (
    typeof record.report_count !== "number" ||
    !Number.isInteger(record.report_count) ||
    record.report_count < 1
  ) {
    push('"report_count" must be an integer >= 1');
  }

  for (const field of ["added_at", "updated_at"]) {
    const v = record[field];
    if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
      push(`"${field}" must be a valid YYYY-MM-DD date string`);
    }
  }
  if (
    typeof record.added_at === "string" &&
    typeof record.updated_at === "string" &&
    DATE_RE.test(record.added_at) &&
    DATE_RE.test(record.updated_at) &&
    record.updated_at < record.added_at
  ) {
    push('"updated_at" must not be earlier than "added_at"');
  }
}

/**
 * @param {unknown} value
 * @param {{ filename?: string }} [opts]  filenameを渡すと id との一致もチェックする
 * @returns {ValidationResult}
 */
export function validateUserRecord(value, opts = {}) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["record must be a JSON object"] };
  }
  const record = /** @type {Record<string, unknown>} */ (value);

  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.includes(key)) {
      push(`unknown key: "${key}"`);
    }
  }

  if (typeof record.id !== "string" || !SNOWFLAKE_RE.test(record.id)) {
    push('"id" must be a Discord snowflake string (17-20 digits)');
  } else if (opts.filename !== undefined) {
    const expected = `${record.id}.json`;
    if (opts.filename !== expected) {
      push(`filename "${opts.filename}" does not match id-derived name "${expected}"`);
    }
  }

  if (
    typeof record.username !== "string" ||
    record.username.length < 1 ||
    record.username.length > NAME_MAX_LENGTH
  ) {
    push(`"username" must be a string of 1-${NAME_MAX_LENGTH} chars`);
  }

  if (record.display_name !== undefined) {
    if (
      typeof record.display_name !== "string" ||
      record.display_name.length < 1 ||
      record.display_name.length > NAME_MAX_LENGTH
    ) {
      push(`"display_name" must be a string of 1-${NAME_MAX_LENGTH} chars when present`);
    }
  }

  if (!Array.isArray(record.categories) || record.categories.length < 1) {
    push('"categories" must be a non-empty array');
  } else {
    const seen = new Set();
    for (const c of record.categories) {
      if (typeof c !== "string" || !CATEGORY_IDS.includes(c)) {
        push(`"categories" contains invalid value: ${JSON.stringify(c)}`);
      } else if (seen.has(c)) {
        push(`"categories" contains duplicate value: "${c}"`);
      } else {
        seen.add(c);
      }
    }
  }

  if (
    typeof record.note !== "string" ||
    record.note.length < 1 ||
    record.note.length > NOTE_MAX_LENGTH
  ) {
    push(`"note" must be a string of 1-${NOTE_MAX_LENGTH} chars`);
  }

  if (typeof record.status !== "string" || !STATUS_VALUES.includes(record.status)) {
    push(`"status" must be one of: ${STATUS_VALUES.join(", ")}`);
  }

  if (record.username_history !== undefined) {
    if (
      !Array.isArray(record.username_history) ||
      record.username_history.length > USERNAME_HISTORY_MAX_ITEMS
    ) {
      push(`"username_history" must be an array of at most ${USERNAME_HISTORY_MAX_ITEMS} items`);
    } else {
      for (const h of record.username_history) {
        if (typeof h !== "string" || h.length < 1 || h.length > NAME_MAX_LENGTH) {
          push(`"username_history" contains an invalid entry: ${JSON.stringify(h)}`);
        }
      }
    }
  }

  validateCommonTailFields(record, push);

  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} value
 * @param {{ filename?: string }} [opts]
 * @returns {ValidationResult}
 */
export function validateServerRecord(value, opts = {}) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["record must be a JSON object"] };
  }
  const record = /** @type {Record<string, unknown>} */ (value);

  for (const key of Object.keys(record)) {
    if (!SERVER_ALLOWED_KEYS.includes(key)) {
      push(`unknown key: "${key}"`);
    }
  }

  if (typeof record.id !== "string" || !SNOWFLAKE_RE.test(record.id)) {
    push('"id" must be a Discord snowflake string (17-20 digits)');
  } else if (opts.filename !== undefined) {
    const expected = `${record.id}.json`;
    if (opts.filename !== expected) {
      push(`filename "${opts.filename}" does not match id-derived name "${expected}"`);
    }
  }

  if (
    typeof record.name !== "string" ||
    record.name.length < 1 ||
    record.name.length > SERVER_NAME_MAX_LENGTH
  ) {
    push(`"name" must be a string of 1-${SERVER_NAME_MAX_LENGTH} chars`);
  }

  if (record.creator_id !== undefined) {
    if (typeof record.creator_id !== "string" || !SNOWFLAKE_RE.test(record.creator_id)) {
      push('"creator_id" must be a Discord snowflake string (17-20 digits) when present');
    }
  }

  if (!Array.isArray(record.categories) || record.categories.length < 1) {
    push('"categories" must be a non-empty array');
  } else {
    const seen = new Set();
    for (const c of record.categories) {
      if (typeof c !== "string" || !SERVER_CATEGORY_IDS.includes(c)) {
        push(`"categories" contains invalid value: ${JSON.stringify(c)}`);
      } else if (seen.has(c)) {
        push(`"categories" contains duplicate value: "${c}"`);
      } else {
        seen.add(c);
      }
    }
  }

  if (
    typeof record.note !== "string" ||
    record.note.length < 1 ||
    record.note.length > NOTE_MAX_LENGTH
  ) {
    push(`"note" must be a string of 1-${NOTE_MAX_LENGTH} chars`);
  }

  if (typeof record.status !== "string" || !STATUS_VALUES.includes(record.status)) {
    push(`"status" must be one of: ${STATUS_VALUES.join(", ")}`);
  }

  if (record.name_history !== undefined) {
    if (
      !Array.isArray(record.name_history) ||
      record.name_history.length > USERNAME_HISTORY_MAX_ITEMS
    ) {
      push(`"name_history" must be an array of at most ${USERNAME_HISTORY_MAX_ITEMS} items`);
    } else {
      for (const h of record.name_history) {
        if (typeof h !== "string" || h.length < 1 || h.length > SERVER_NAME_MAX_LENGTH) {
          push(`"name_history" contains an invalid entry: ${JSON.stringify(h)}`);
        }
      }
    }
  }

  validateCommonTailFields(record, push);

  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} value
 * @param {{ filename?: string }} [opts]
 * @returns {ValidationResult}
 */
export function validateBotRecord(value, opts = {}) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { valid: false, errors: ["record must be a JSON object"] };
  }
  const record = /** @type {Record<string, unknown>} */ (value);

  for (const key of Object.keys(record)) {
    if (!BOT_ALLOWED_KEYS.includes(key)) {
      push(`unknown key: "${key}"`);
    }
  }

  if (typeof record.id !== "string" || !SNOWFLAKE_RE.test(record.id)) {
    push('"id" must be a Discord snowflake string (17-20 digits)');
  } else if (opts.filename !== undefined) {
    const expected = `${record.id}.json`;
    if (opts.filename !== expected) {
      push(`filename "${opts.filename}" does not match id-derived name "${expected}"`);
    }
  }

  if (
    typeof record.username !== "string" ||
    record.username.length < 1 ||
    record.username.length > NAME_MAX_LENGTH
  ) {
    push(`"username" must be a string of 1-${NAME_MAX_LENGTH} chars`);
  }

  if (record.developer_id !== undefined) {
    if (typeof record.developer_id !== "string" || !SNOWFLAKE_RE.test(record.developer_id)) {
      push('"developer_id" must be a Discord snowflake string (17-20 digits) when present');
    }
  }

  if (!Array.isArray(record.categories) || record.categories.length < 1) {
    push('"categories" must be a non-empty array');
  } else {
    const seen = new Set();
    for (const c of record.categories) {
      if (typeof c !== "string" || !BOT_CATEGORY_IDS.includes(c)) {
        push(`"categories" contains invalid value: ${JSON.stringify(c)}`);
      } else if (seen.has(c)) {
        push(`"categories" contains duplicate value: "${c}"`);
      } else {
        seen.add(c);
      }
    }
  }

  if (
    typeof record.note !== "string" ||
    record.note.length < 1 ||
    record.note.length > NOTE_MAX_LENGTH
  ) {
    push(`"note" must be a string of 1-${NOTE_MAX_LENGTH} chars`);
  }

  if (typeof record.status !== "string" || !STATUS_VALUES.includes(record.status)) {
    push(`"status" must be one of: ${STATUS_VALUES.join(", ")}`);
  }

  if (record.username_history !== undefined) {
    if (
      !Array.isArray(record.username_history) ||
      record.username_history.length > USERNAME_HISTORY_MAX_ITEMS
    ) {
      push(`"username_history" must be an array of at most ${USERNAME_HISTORY_MAX_ITEMS} items`);
    } else {
      for (const h of record.username_history) {
        if (typeof h !== "string" || h.length < 1 || h.length > NAME_MAX_LENGTH) {
          push(`"username_history" contains an invalid entry: ${JSON.stringify(h)}`);
        }
      }
    }
  }

  validateCommonTailFields(record, push);

  return { valid: errors.length === 0, errors };
}

/**
 * dist/{users,servers,bots}.json / dist/*-stats.json 生成用の集計ヘルパー（3種共通）。
 * 「listedのみを公開統計・公開一覧に含める」という設計判断をここに閉じ込める
 * （delistedは撤回済みのため、公開面には出さない前提）。
 *
 * @param {Array<Record<string, unknown>>} validRecords  対応するvalidate*Recordを通過済みのレコード群
 * @param {readonly string[]} categoryIds
 * @param {readonly string[]} listFields  出力レコードに含めるフィールド名（順序も出力順になる）
 */
export function buildDistPayload(validRecords, categoryIds, listFields) {
  const listed = validRecords.filter((r) => r.status === "listed");

  const byCategory = Object.fromEntries(categoryIds.map((c) => [c, 0]));
  let totalReports = 0;

  for (const r of listed) {
    totalReports += Number(r.report_count) || 0;
    for (const c of /** @type {string[]} */ (r.categories)) {
      byCategory[c] = (byCategory[c] ?? 0) + 1;
    }
  }

  const records = listed
    .map((r) => {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const field of listFields) {
        if (r[field] !== undefined) out[field] = r[field];
      }
      return out;
    })
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

  const stats = {
    generated_at: new Date().toISOString(),
    total_listed: listed.length,
    total_reports: totalReports,
    by_category: byCategory,
  };

  return { records, stats };
}

// user向けフィールド順（既存dist/users.jsonの出力順を変えないための固定リスト）
export const USER_LIST_FIELDS = Object.freeze([
  "id",
  "username",
  "display_name",
  "categories",
  "note",
  "status",
  "username_history",
  "report_count",
  "added_at",
  "updated_at",
]);

export const SERVER_LIST_FIELDS = Object.freeze([
  "id",
  "name",
  "creator_id",
  "categories",
  "note",
  "status",
  "name_history",
  "report_count",
  "added_at",
  "updated_at",
]);

export const BOT_LIST_FIELDS = Object.freeze([
  "id",
  "username",
  "developer_id",
  "categories",
  "note",
  "status",
  "username_history",
  "report_count",
  "added_at",
  "updated_at",
]);

/** 既存呼び出し互換用ラッパー（user専用・引数なしの旧シグネチャのまま使える） */
export function buildUserDistPayload(validRecords) {
  const { records, stats } = buildDistPayload(validRecords, CATEGORY_IDS, USER_LIST_FIELDS);
  return { users: records, stats };
}
