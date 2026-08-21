/**
 * users/<discordID>.json のバリデーションロジック。
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
 * schema/user.schema.json はドキュメント・エディタ補完用、
 * 実行時の正はこのファイルという役割分担にしている。
 */

export const CATEGORY_IDS = Object.freeze([
  "scam",
  "phishing",
  "impersonation",
  "raid-spam",
  "dm-solicitation",
  "harassment",
  "doxxing",
  "hate-speech",
  "bot-abuse",
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

const SNOWFLAKE_RE = /^[0-9]{17,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX_LENGTH = 1000;
const NAME_MAX_LENGTH = 32;
const USERNAME_HISTORY_MAX_ITEMS = 50;

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors  空なら valid===true
 */

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

  // 未知キーの拒否（additionalProperties:false 相当）
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.includes(key)) {
      push(`unknown key: "${key}"`);
    }
  }

  // --- id ---
  if (typeof record.id !== "string" || !SNOWFLAKE_RE.test(record.id)) {
    push('"id" must be a Discord snowflake string (17-20 digits)');
  } else if (opts.filename !== undefined) {
    const expected = `${record.id}.json`;
    if (opts.filename !== expected) {
      push(`filename "${opts.filename}" does not match id-derived name "${expected}"`);
    }
  }

  // --- username ---
  if (
    typeof record.username !== "string" ||
    record.username.length < 1 ||
    record.username.length > NAME_MAX_LENGTH
  ) {
    push(`"username" must be a string of 1-${NAME_MAX_LENGTH} chars`);
  }

  // --- display_name (optional) ---
  if (record.display_name !== undefined) {
    if (
      typeof record.display_name !== "string" ||
      record.display_name.length < 1 ||
      record.display_name.length > NAME_MAX_LENGTH
    ) {
      push(`"display_name" must be a string of 1-${NAME_MAX_LENGTH} chars when present`);
    }
  }

  // --- categories ---
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

  // --- note ---
  if (
    typeof record.note !== "string" ||
    record.note.length < 1 ||
    record.note.length > NOTE_MAX_LENGTH
  ) {
    push(`"note" must be a string of 1-${NOTE_MAX_LENGTH} chars`);
  }

  // --- status ---
  if (typeof record.status !== "string" || !STATUS_VALUES.includes(record.status)) {
    push(`"status" must be one of: ${STATUS_VALUES.join(", ")}`);
  }

  // --- username_history (optional) ---
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

  // --- report_count ---
  if (
    typeof record.report_count !== "number" ||
    !Number.isInteger(record.report_count) ||
    record.report_count < 1
  ) {
    push('"report_count" must be an integer >= 1');
  }

  // --- added_at / updated_at ---
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

  return { valid: errors.length === 0, errors };
}

/**
 * dist/users.json / dist/stats.json 生成用の集計ヘルパー。
 * 「listedのみを公開統計・公開一覧に含める」という設計判断をここに閉じ込める
 * （delistedは撤回済みのため、公開面には出さない前提）。
 *
 * @param {Array<Record<string, unknown>>} validRecords  validateUserRecordを通過済みのレコード群
 */
export function buildDistPayload(validRecords) {
  const listed = validRecords.filter((r) => r.status === "listed");

  /** @type {Record<string, number>} */
  const byCategory = Object.fromEntries(CATEGORY_IDS.map((c) => [c, 0]));
  let totalReports = 0;

  for (const r of listed) {
    totalReports += Number(r.report_count) || 0;
    for (const c of /** @type {string[]} */ (r.categories)) {
      byCategory[c] = (byCategory[c] ?? 0) + 1;
    }
  }

  const users = listed
    .map((r) => ({
      id: r.id,
      username: r.username,
      ...(r.display_name !== undefined ? { display_name: r.display_name } : {}),
      categories: r.categories,
      note: r.note,
      status: r.status,
      ...(r.username_history !== undefined ? { username_history: r.username_history } : {}),
      report_count: r.report_count,
      added_at: r.added_at,
      updated_at: r.updated_at,
    }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

  const stats = {
    generated_at: new Date().toISOString(),
    total_listed: listed.length,
    total_reports: totalReports,
    by_category: byCategory,
  };

  return { users, stats };
}
