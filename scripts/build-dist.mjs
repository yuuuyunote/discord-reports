#!/usr/bin/env node
/**
 * users/*.json, servers/*.json, bots/*.json を全件読み込み・検証し、
 * dist/{users,servers,bots}.json と dist/{users,servers,bots}-stats.json を再生成する。
 * dist/stats.json は既存互換のため users 分のエイリアスとして残す。
 *
 * 設計判断:
 * - Worker側の事前検証がメインの関所だが、それでも
 *   (a) Workerのバグ、(b) メンテナがGitHub UIから直接編集、
 *   (c) スキーマ変更後の既存ファイルの陳腐化
 *   のケースで不正なファイルがmainに載る可能性は残る。
 * - そのため、不正なファイルが1件でもあっても *ビルド全体を止めない*。
 *   その1件をdistから除外し、残りは正常に公開する（サイトを道連れにしない）。
 *   これは3種別（user/server/bot）それぞれ独立に適用する。
 * - ただし「気付かれない」のは最悪なので、
 *   - 標準エラーに詳細を出す
 *   - failures.json に3種分まとめて書き出す
 *   - プロセスの終了コードを1にしてCIジョブ自体は失敗させる（GitHub Actionsが赤くなる）
 *   の3点で必ず可視化する。
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateUserRecord,
  validateServerRecord,
  validateBotRecord,
  buildDistPayload,
  CATEGORY_IDS,
  SERVER_CATEGORY_IDS,
  BOT_CATEGORY_IDS,
  USER_LIST_FIELDS,
  SERVER_LIST_FIELDS,
  BOT_LIST_FIELDS,
} from "../src/validation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST_DIR = join(ROOT, "dist");

/** @type {Array<{ type: string, dirName: string, outName: string, validate: Function, categoryIds: readonly string[], listFields: readonly string[] }>} */
const TARGETS = [
  {
    type: "user",
    dirName: "users",
    outName: "users",
    validate: validateUserRecord,
    categoryIds: CATEGORY_IDS,
    listFields: USER_LIST_FIELDS,
  },
  {
    type: "server",
    dirName: "servers",
    outName: "servers",
    validate: validateServerRecord,
    categoryIds: SERVER_CATEGORY_IDS,
    listFields: SERVER_LIST_FIELDS,
  },
  {
    type: "bot",
    dirName: "bots",
    outName: "bots",
    validate: validateBotRecord,
    categoryIds: BOT_CATEGORY_IDS,
    listFields: BOT_LIST_FIELDS,
  },
];

async function processTarget(target) {
  const dirPath = join(ROOT, target.dirName);

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") {
      // ディレクトリ未作成（まだ1件も登録がない）場合は空扱いで継続する
      entries = [];
    } else {
      throw e;
    }
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  const validRecords = [];
  const failures = [];

  for (const filename of files) {
    const path = join(dirPath, filename);
    const raw = await readFile(path, "utf8");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      failures.push({ type: target.type, file: filename, errors: [`invalid JSON: ${e.message}`] });
      continue;
    }

    const { valid, errors } = target.validate(parsed, { filename });
    if (!valid) {
      failures.push({ type: target.type, file: filename, errors });
      continue;
    }

    validRecords.push(parsed);
  }

  const { records, stats } = buildDistPayload(validRecords, target.categoryIds, target.listFields);

  return { target, files, records, stats, failures };
}

async function main() {
  const results = await Promise.all(TARGETS.map(processTarget));

  await mkdir(DIST_DIR, { recursive: true });

  const allFailures = [];
  let summary = "";

  for (const { target, files, records, stats, failures } of results) {
    await writeFile(
      join(DIST_DIR, `${target.outName}.json`),
      JSON.stringify(records, null, 2) + "\n",
      "utf8"
    );
    await writeFile(
      join(DIST_DIR, `${target.outName}-stats.json`),
      JSON.stringify(stats, null, 2) + "\n",
      "utf8"
    );
    allFailures.push(...failures);
    summary += `checked ${files.length} ${target.type} file(s): ${records.length} listed, ${failures.length} failed\n`;
  }

  // 既存サイト・既存呼び出し互換のため dist/stats.json は users 分のエイリアスとして残す
  const usersResult = results.find((r) => r.target.type === "user");
  if (usersResult) {
    await writeFile(
      join(DIST_DIR, "stats.json"),
      JSON.stringify(usersResult.stats, null, 2) + "\n",
      "utf8"
    );
  }

  console.log(summary.trimEnd());

  if (allFailures.length > 0) {
    await writeFile(
      join(DIST_DIR, "failures.json"),
      JSON.stringify({ generated_at: new Date().toISOString(), failures: allFailures }, null, 2) + "\n",
      "utf8"
    );
    console.error("\n=== VALIDATION FAILURES (excluded from dist) ===");
    for (const f of allFailures) {
      console.error(`- [${f.type}] ${f.file}`);
      for (const err of f.errors) console.error(`    ${err}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
