#!/usr/bin/env node
/**
 * users/*.json を全件読み込み・検証し、dist/users.json と dist/stats.json を再生成する。
 *
 * 設計判断:
 * - Worker側の事前検証がメインの関所だが、それでも
 *   (a) Workerのバグ、(b) メンテナがGitHub UIから直接編集、
 *   (c) スキーマ変更後の既存ファイルの陳腐化
 *   のケースで不正なファイルがmainに載る可能性は残る。
 * - そのため、不正なファイルが1件でもあっても *ビルド全体を止めない*。
 *   その1件をdistから除外し、残りは正常に公開する（サイトを道連れにしない）。
 * - ただし「気付かれない」のは最悪なので、
 *   - 標準エラーに詳細を出す
 *   - failures.json を書き出す
 *   - プロセスの終了コードを1にしてCIジョブ自体は失敗させる（GitHub Actionsが赤くなる）
 *   の3点で必ず可視化する。
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateUserRecord, buildDistPayload } from "../src/validation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const USERS_DIR = join(ROOT, "users");
const DIST_DIR = join(ROOT, "dist");

async function main() {
  const entries = await readdir(USERS_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();

  const validRecords = [];
  const failures = [];

  for (const filename of files) {
    const path = join(USERS_DIR, filename);
    const raw = await readFile(path, "utf8");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      failures.push({ file: filename, errors: [`invalid JSON: ${e.message}`] });
      continue;
    }

    const { valid, errors } = validateUserRecord(parsed, { filename });
    if (!valid) {
      failures.push({ file: filename, errors });
      continue;
    }

    validRecords.push(parsed);
  }

  const { users, stats } = buildDistPayload(validRecords);

  await mkdir(DIST_DIR, { recursive: true });
  await writeFile(join(DIST_DIR, "users.json"), JSON.stringify(users, null, 2) + "\n", "utf8");
  await writeFile(join(DIST_DIR, "stats.json"), JSON.stringify(stats, null, 2) + "\n", "utf8");

  console.log(`checked ${files.length} file(s): ${validRecords.length} valid, ${failures.length} failed`);
  console.log(`dist/users.json: ${users.length} listed record(s)`);

  if (failures.length > 0) {
    await writeFile(
      join(DIST_DIR, "failures.json"),
      JSON.stringify({ generated_at: new Date().toISOString(), failures }, null, 2) + "\n",
      "utf8"
    );
    console.error("\n=== VALIDATION FAILURES (excluded from dist) ===");
    for (const f of failures) {
      console.error(`- ${f.file}`);
      for (const err of f.errors) console.error(`    ${err}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
