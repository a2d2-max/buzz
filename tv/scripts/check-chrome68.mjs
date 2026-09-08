// dist 산출물이 Chromium 68(webOS TV 5.x, LG GX 2020)에서 파싱되는지 재는 게이트.
// grep 휴리스틱은 문자열 오탐이 있어 acorn 으로 실제 파스한 뒤,
// 크롬 68 에 없는 문법 노드를 전수로 찾는다.
//
// 잡는 것(전부 크롬 69+ 도입 문법):
//   ?. / ?? (80) · ||= &&= ??= (85) · 클래스 필드(72)/프라이빗(74)/static 블록(91)
//   · 숫자 구분자 1_000 (75) · RegExp d 플래그(90) · export * as ns (72)
// 안 잡는 것(크롬 68 이하에 이미 있음): async/await·제너레이터·BigInt 리터럴(67)
//   · import.meta(64) · optional catch(66) · lookbehind(62) · named groups(64)
//
// 한계: 이건 "문법" 게이트다. 없는 API(런타임)는 core-js 폴리필 책임이고,
// 진짜 증거는 실기(webOS 5.x) 또는 실제 Chromium 68 실행뿐이다.

import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";
import { fullAncestor } from "acorn-walk";

const distDir = path.resolve(process.argv[2] ?? "dist/assets");
const files = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(distDir, name));

if (files.length === 0) {
  console.error(`검사할 JS 가 없습니다: ${distDir} — 먼저 pnpm build`);
  process.exit(1);
}

let violations = 0;

function report(file, node, what) {
  violations += 1;
  console.error(`  ✗ ${path.basename(file)} @${node.start}: ${what}`);
}

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src, {
      ecmaVersion: 2023,
      sourceType: "module",
      allowHashBang: true,
    });
  } catch (error) {
    console.error(`  ✗ ${path.basename(file)}: 파스 실패 — ${error.message}`);
    violations += 1;
    continue;
  }

  fullAncestor(ast, (node) => {
    switch (node.type) {
      case "ChainExpression":
        report(file, node, "옵셔널 체이닝 ?. (크롬 80+)");
        break;
      case "LogicalExpression":
        if (node.operator === "??") {
          report(file, node, "널 병합 ?? (크롬 80+)");
        }
        break;
      case "AssignmentExpression":
        if (["||=", "&&=", "??="].includes(node.operator)) {
          report(file, node, `논리 할당 ${node.operator} (크롬 85+)`);
        }
        break;
      case "PropertyDefinition":
        report(file, node, "클래스 필드 (크롬 72+)");
        break;
      case "PrivateIdentifier":
        report(file, node, "프라이빗 필드 #x (크롬 74+)");
        break;
      case "StaticBlock":
        report(file, node, "static {} 블록 (크롬 91+)");
        break;
      case "ExportAllDeclaration":
        if (node.exported) {
          report(file, node, "export * as ns (크롬 72+)");
        }
        break;
      case "Literal":
        if (typeof node.value === "number" && node.raw?.includes("_")) {
          report(file, node, "숫자 구분자 1_000 (크롬 75+)");
        }
        if (node.regex?.flags?.includes("d")) {
          report(file, node, "RegExp d 플래그 (크롬 90+)");
        }
        break;
      default:
        break;
    }
  });
}

if (violations > 0) {
  console.error(
    `\n크롬 68 금지 문법 ${violations}건 — build.target 을 확인하세요.`,
  );
  process.exit(1);
}
console.log(`chrome68 문법 검사 통과 (${files.length}개 파일)`);
