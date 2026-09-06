// 一次性验证:加载 .tmp-min 下压缩后的运行时模块,确认无语法错误。
// (执行到浏览器 API 缺失报错属预期——解析成功;SyntaxError 才代表压缩破坏了代码)
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(".tmp-min");
let bad = 0;
let ok = 0;

async function check(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await check(p);
      continue;
    }
    const url = "file://" + path.resolve(p).replace(/\\/g, "/");
    try {
      await import(url + "?t=" + Math.random());
      ok++;
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.log("SYNTAX FAIL:", p, String(err));
        bad++;
      } else {
        ok++; // 运行期错误(document/window 缺失等)= 解析成功
      }
    }
  }
}

await check(root);
console.log(`parse ok: ${ok}, broken: ${bad}`);
if (bad > 0) process.exit(1);
