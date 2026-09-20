// ---------------------------------------------------------------------------
// 二维码编码器自检（开发期脚本，不参与构建；vite --ssr 打包后 node 运行）：
//   1) 与参考实现（qrcode@1.5.4）逐模块比对——覆盖版本 1~40 × 四个纠错等级 ×
//      固定掩码 0~7 与自动选掩码，逐一比较矩阵，任何差异都会导致失败。
//      参考实现默认会把文本切分成数字/字母数字/字节混合段以省比特（自研实现
//      只用字节模式），编码内容因此合法地不同；比对时必须把参考实现钉在单一
//      字节段（{data, mode: BYTE}）上，否则比的是两种编码方案而非实现正确性。
//   2) 用独立解码器（jsQR）解码自己生成的矩阵——证明产出的码真的能被扫出来，
//      这一条覆盖「矩阵自洽但不可扫」与「编码方案不同但同样合法」的情况。
//
// 参考实现与解码器只在开发期使用，不进仓库依赖：
//   npm pack qrcode@1.5.4 && npm pack jsqr@1.4.0 && npm pack dijkstrajs@1.0.3
//   解压到 .tmp-qrcheck/ref/qrcode（dijkstrajs 放其 node_modules/）与 .tmp-qrcheck/ref/jsqr
// 缺参考实现时脚本跳过比对（只跑解码自检），不报错。
//
// 运行：
//   npx vite build --ssr scripts/qr-selfcheck.ts --outDir .tmp-qrcheck/out --emptyOutDir \
//     && node .tmp-qrcheck/out/qr-selfcheck.js
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeQr, pickVersion, qrSvg, type QrEcc } from "../src/app/lib/lan-share/qr";

const require = createRequire(import.meta.url);
// 参考实现放在仓库根的 .tmp-qrcheck/（gitignore 已含 .tmp*）。脚本经 vite --ssr
// 打包后落在 .tmp-qrcheck/out/，故按 cwd 与产物目录两处探测。
const candidates = [
  join(process.cwd(), ".tmp-qrcheck"),
  join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-qrcheck"),
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-qrcheck"),
];
const tmpRoot = candidates.find((p) => existsSync(p)) ?? candidates[0];
const refQrPath = join(tmpRoot, "ref", "qrcode", "lib", "core", "qrcode.js");
const refJsQrPath = join(tmpRoot, "ref", "jsqr", "dist", "jsQR.js");

const ECCS: QrEcc[] = ["L", "M", "Q", "H"];
const LENGTHS = [1, 7, 14, 20, 40, 90, 180, 400, 900, 1600, 2500, 2900];

/**
 * 样本文本：短样本混入中文（覆盖多字节 UTF-8 的字符计数），
 * 长样本用纯 ASCII（字符数 == 字节数，才能逼近版本容量上限）。
 */
function sampleText(index: number, length: number): string {
  const seeds = [
    "http://192.168.1.108:39200/",
    "http://10.0.0.7:39200/s/wb3k9x2a/",
    "TvE 白板 · 局域网共享",
    "https://example.com/a/b/c?k=1&m=2#frag",
    "局域网共享地址：http://172.16.31.24:39200/",
  ];
  const pool = length <= 40 ? seeds : seeds.filter((s) => /^[\x20-\x7e]*$/.test(s));
  let out = pool[index % pool.length];
  while (out.length < length) out += pool[(index + out.length) % pool.length];
  return out.slice(0, Math.max(1, length));
}

interface Failure {
  what: string;
  detail: string;
}

const failures: Failure[] = [];
let compared = 0;
let decoded = 0;
let skipped = 0;
/** 与参考实现取到不同掩码、但能被 N4 取整规则解释的例数 */
let maskN4Only = 0;

/**
 * 在「参考实现的 N1~N3 + 规范下取整 N4」口径下重算最低分掩码。
 * 用于验证自研实现的掩码选择，避免把「N4 取整口径不同」误判成实现错误。
 */
function specN4BestMask(
  refQr: { create: (d: unknown, o: unknown) => { modules: { data: Uint8Array } } },
  maskPattern: { getPenaltyN1: (m: unknown) => number; getPenaltyN2: (m: unknown) => number; getPenaltyN3: (m: unknown) => number },
  seg: (t: string) => unknown,
  text: string,
  ecc: QrEcc,
  version: number,
): number {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = refQr.create(seg(text), { errorCorrectionLevel: ecc, version, maskPattern: mask });
    const n123 =
      maskPattern.getPenaltyN1(m.modules) +
      maskPattern.getPenaltyN2(m.modules) +
      maskPattern.getPenaltyN3(m.modules);
    let dark = 0;
    for (let i = 0; i < m.modules.data.length; i++) dark += m.modules.data[i];
    const percent = (dark * 100) / m.modules.data.length;
    const score = n123 + Math.floor(Math.abs(percent - 50) / 5) * 10;
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

// --- 1) 与参考实现逐模块比对 ------------------------------------------------
const refQr = existsSync(refQrPath) ? require(refQrPath) : null;
// 参考实现钉在单一字节段上（见文件头说明）
const refMode = refQr ? require(join(tmpRoot, "ref", "qrcode", "lib", "core", "mode.js")) : null;
const refMaskPattern = refQr
  ? require(join(tmpRoot, "ref", "qrcode", "lib", "core", "mask-pattern.js"))
  : null;
const asByteSegment = (text: string): { data: string; mode: unknown }[] => [
  { data: text, mode: refMode.BYTE },
];
if (!refQr) {
  console.log("[qr-selfcheck] 未找到参考实现，跳过逐模块比对（见文件头注释）");
} else {
  for (const ecc of ECCS) {
    for (let version = 1; version <= 40; version++) {
      for (let li = 0; li < LENGTHS.length; li++) {
        const text = sampleText(li + version, LENGTHS[li]);
        let ref: { modules: { size: number; data: Uint8Array }; maskPattern: number };
        let mine: ReturnType<typeof encodeQr>;
        try {
          ref = refQr.create(asByteSegment(text), { errorCorrectionLevel: ecc, version });
        } catch {
          continue; // 该版本装不下这段文本，跳过
        }
        try {
          mine = encodeQr(text, { ecc, version });
        } catch (e) {
          failures.push({
            what: `v${version}-${ecc} len=${text.length}`,
            detail: `参考实现可编码但自研实现抛错: ${String(e)}`,
          });
          continue;
        }

        // 逐掩码比对（掩码选择逻辑之外的路径全在这里覆盖）
        for (let mask = 0; mask < 8; mask++) {
          const forcedRef = refQr.create(asByteSegment(text), {
            errorCorrectionLevel: ecc,
            version,
            maskPattern: mask,
          });
          const forcedMine = encodeQr(text, { ecc, version, mask });
          compared++;
          if (forcedRef.modules.size !== forcedMine.size) {
            failures.push({
              what: `v${version}-${ecc} mask${mask}`,
              detail: `尺寸不同: 参考 ${forcedRef.modules.size} / 自研 ${forcedMine.size}`,
            });
            break;
          }
          let diff = -1;
          for (let row = 0; row < forcedMine.size && diff < 0; row++) {
            for (let col = 0; col < forcedMine.size; col++) {
              const a = forcedRef.modules.data[row * forcedMine.size + col] ? 1 : 0;
              const b = forcedMine.modules[row * forcedMine.size + col] ? 1 : 0;
              if (a !== b) {
                diff = row * forcedMine.size + col;
                break;
              }
            }
          }
          if (diff >= 0) {
            failures.push({
              what: `v${version}-${ecc} mask${mask} len=${text.length}`,
              detail: `模块不一致 @(${Math.floor(diff / forcedMine.size)},${diff % forcedMine.size})`,
            });
          }
        }

        // 自动选掩码：参考实现与规范在 N4（深色占比罚分）的取整上不同——
        // 规范是「偏离 50% 的 5% 档数」下取整，参考实现是上取整，个别用例会因此
        // 选中不同掩码。两者都是合法可扫的码，所以这里不放行「随便不同」，
        // 而是要求：自研所选必须等于「参考的 N1~N3 + 规范 N4」口径下的最低分掩码。
        compared++;
        if (ref.maskPattern !== mine.mask) {
          const specBest = specN4BestMask(refQr, refMaskPattern, asByteSegment, text, ecc, version);
          if (specBest === mine.mask) {
            maskN4Only++;
          } else {
            failures.push({
              what: `v${version}-${ecc} 自动掩码 len=${text.length}`,
              detail: `参考选 ${ref.maskPattern} / 自研选 ${mine.mask} / 规范 N4 口径应为 ${specBest}`,
            });
          }
        }
      }
    }
  }
}

// --- 2) 独立解码器解码自研矩阵 ----------------------------------------------
const jsQR = existsSync(refJsQrPath) ? require(refJsQrPath) : null;
if (!jsQR) {
  console.log("[qr-selfcheck] 未找到 jsQR，跳过解码自检");
} else {
  const decode = (typeof jsQR === "function" ? jsQR : jsQR.default) as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    opts: { inversionAttempts: string },
  ) => { data: string } | null;

  const quiet = 4;
  const scale = 4;
  const render = (modules: boolean[], size: number): { data: Uint8ClampedArray; w: number } => {
    const w = (size + quiet * 2) * scale;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!modules[row * size + col]) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const at = (((row + quiet) * scale + dy) * w + (col + quiet) * scale + dx) * 4;
            data[at] = data[at + 1] = data[at + 2] = 0;
            data[at + 3] = 255;
          }
        }
      }
    }
    return { data, w };
  };

  const cases: { text: string; ecc: QrEcc }[] = [];
  /** 该纠错等级下版本 40 能装的字节数（用来跳过装不下的样本） */
  const maxBytes = (ecc: QrEcc): number => {
    let fit = 0;
    for (let len = 1; len <= 3000; len++) {
      try {
        pickVersion(len, ecc);
        fit = len;
      } catch {
        break;
      }
    }
    return fit;
  };
  for (const ecc of ECCS) {
    for (const len of [8, 20, 44, 120, 400, 1000, 2400]) {
      cases.push({ text: sampleText(len, len), ecc });
    }
    cases.push({ text: `http://192.168.31.77:39200/s/${ecc}9x2a1b`, ecc });
    cases.push({ text: "局域网共享 · TvE 白板 放映页", ecc });
  }

  for (const c of cases) {
    const bytes = new TextEncoder().encode(c.text).length;
    if (bytes > maxBytes(c.ecc)) {
      skipped++;
      continue; // 该纠错等级装不下这个长度（长样本按字节算），跳过
    }
    const m = encodeQr(c.text, { ecc: c.ecc });
    const img = render(m.modules, m.size);
    const got = decode(img.data, img.w, img.w, { inversionAttempts: "dontInvert" });
    decoded++;
    if (!got) {
      failures.push({ what: `${c.ecc} len=${c.text.length} 解码`, detail: "解码器未识别出二维码" });
    } else if (got.data !== c.text) {
      failures.push({
        what: `${c.ecc} len=${c.text.length} 解码`,
        detail: `内容不一致: 期望 ${c.text.length} 字符 / 得到 ${got.data.length} 字符`,
      });
    }
  }

  // 八个掩码逐个解码：证明掩码只改明暗分布、不影响可读性
  for (const ecc of ECCS) {
    for (let mask = 0; mask < 8; mask++) {
      const text = `http://192.168.31.77:39200/s/wb${mask}`;
      const m = encodeQr(text, { ecc, mask });
      const img = render(m.modules, m.size);
      const got = decode(img.data, img.w, img.w, { inversionAttempts: "dontInvert" });
      decoded++;
      if (!got || got.data !== text) {
        failures.push({ what: `${ecc} mask${mask} 解码`, detail: got ? "内容不一致" : "解码失败" });
      }
    }
  }

  // 自动选版本的边界：恰好装得下的字节数应可编码且可解码。
  // 这里必须用纯 ASCII（字符数 == 字节数），中文样本按字符截会超容量。
  for (const ecc of ECCS) {
    let fit = 1;
    for (let len = 1; len <= 2953; len++) {
      try {
        pickVersion(len, ecc);
        fit = len;
      } catch {
        break;
      }
    }
    const text = "http://192.168.1.108:39200/".padEnd(fit, "a").slice(0, fit);
    try {
      const m = encodeQr(text, { ecc });
      const img = render(m.modules, m.size);
      const got = decode(img.data, img.w, img.w, { inversionAttempts: "dontInvert" });
      decoded++;
      if (!got || got.data !== text) {
        failures.push({
          what: `${ecc} 最大容量 ${fit} 字节`,
          detail: got ? "解码内容不一致" : "解码失败",
        });
      }
    } catch (e) {
      skipped++;
      failures.push({ what: `${ecc} 最大容量 ${fit} 字节`, detail: `编码抛错: ${String(e)}` });
    }
  }
}

// --- 3) SVG 渲染几何校验 -----------------------------------------------------
// 前面的解码自检证明「矩阵可扫」，这里证明「画出来的 SVG 与矩阵一致」：
// 反解 qrSvg 生成的一条 path，还原成模块格，与矩阵逐格比对；
// 整体尺寸与静区宽度也一并断言（静区画错会让实测扫不出来）。
{
  const renderCases = [
    "http://192.168.1.108:39200/",
    "http://10.0.0.7:39200/s/wb3k9x2a/",
    "局域网共享 · TvE 白板",
    "x".repeat(600),
  ];
  for (const text of renderCases) {
    for (const scale of [3, 8]) {
      const m = encodeQr(text, {});
      const quiet = 4;
      const markup = qrSvg(m, { scale, quiet });
      compared++;
      const total = (m.size + quiet * 2) * scale;
      const dims = `width="${total}" height="${total}" viewBox="0 0 ${total} ${total}"`;
      if (!markup.includes(dims)) {
        failures.push({ what: `SVG 尺寸 scale=${scale}`, detail: `缺少 ${dims}` });
        continue;
      }
      const pathMatch = markup.match(/<path d="([^"]*)"/);
      if (!pathMatch) {
        failures.push({ what: "SVG path", detail: "没有生成深色模块 path" });
        continue;
      }
      // 反解 path：M{x} {y}h{w}v{scale}h{-w}z → 覆盖的模块格
      const grid = new Set<string>();
      const segs = pathMatch[1].match(/M\d+ \d+h\d+v\d+h-\d+z/g) ?? [];
      for (const seg of segs) {
        const nums = (seg.slice(1).match(/\d+/g) ?? []).map(Number);
        const x = nums[0];
        const y = nums[1];
        const w = nums[2];
        const col0 = x / scale - quiet;
        const row = y / scale - quiet;
        const run = w / scale;
        if (!Number.isInteger(col0) || !Number.isInteger(row) || !Number.isInteger(run)) {
          failures.push({ what: "SVG path 几何", detail: `未落在整数模块格: ${seg}` });
          break;
        }
        for (let d = 0; d < run; d++) grid.add(`${row},${col0 + d}`);
      }
      let diff = 0;
      for (let row = 0; row < m.size; row++) {
        for (let col = 0; col < m.size; col++) {
          if (m.modules[row * m.size + col] !== grid.has(`${row},${col}`)) diff++;
        }
      }
      if (diff) {
        failures.push({
          what: `SVG 与矩阵不一致 len=${text.length} scale=${scale}`,
          detail: `${diff} 格不同`,
        });
      }
    }
  }
}

console.log(
  `[qr-selfcheck] 比对 ${compared} 组矩阵/SVG · 解码 ${decoded} 例 · 跳过 ${skipped} 例 · ` +
    `掩码差异可由 N4 取整解释 ${maskN4Only} 例 · 失败 ${failures.length} 例`,
);
for (const f of failures.slice(0, 40)) console.log(`  ✗ ${f.what}: ${f.detail}`);
if (failures.length > 40) console.log(`  … 其余 ${failures.length - 40} 例略`);
if (failures.length) {
  process.exitCode = 1;
} else {
  console.log("[qr-selfcheck] 通过");
}
