// ---------------------------------------------------------------------------
// smoke 交互多选菜单（零依赖：readline keypress）：↑↓ 移动 · 空格勾选 ·
// a 全选/清空 · 回车运行 · q/Ctrl-C 退出。从 runner.mjs 抽出，供无参数且
// 交互终端时弹出；非交互环境不使用。
// ---------------------------------------------------------------------------
import readline from "node:readline";

/**
 * @param {Array<{id: string; kind: string; desc: string; priority: string}>} suites
 * @returns {Promise<Array<{id: string; kind: string; desc: string; priority: string}> | null>}
 *     选中的套件列表；取消/退出返回 null。
 */
export async function pickInteractively(suites) {
  if (!suites.length) return [];
  console.log(`smoke 套件菜单（共 ${suites.length} 项）—— ↑↓ 移动 · 空格勾选 · a 全选/清空 · 回车运行 · q 退出`);
  const checked = suites.map(() => false);
  checked[0] = true;
  let cursor = 0;
  let lastLines = 0;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write("\x1b[?25l"); // 隐藏光标

  const width = () => process.stdout.columns ?? 100;
  function frame() {
    const lines = [`  已选 ${checked.filter(Boolean).length}/${suites.length}`];
    const H = Math.min(14, suites.length);
    const start = Math.max(0, Math.min(cursor - (H >> 1), suites.length - H));
    for (let i = start; i < start + H && i < suites.length; i++) {
      const s = suites[i];
      const pointer = i === cursor ? "❯" : " ";
      const box = checked[i] ? "◉" : "○";
      const descMax = Math.max(12, width() - 46);
      const desc = s.desc.length > descMax ? `${s.desc.slice(0, descMax)}…` : s.desc;
      lines.push(`${pointer} ${box} ${s.priority} ${s.id.padEnd(22)} ${s.kind.padEnd(4)} ${desc}`);
    }
    return lines.join("\n");
  }
  function draw() {
    const f = frame();
    if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A`);
    process.stdout.write(`${f.split("\n").map((l) => `${l}\x1b[0K`).join("\n")}\n`);
    lastLines = f.split("\n").length;
  }

  return await new Promise((resolveP) => {
    function cleanup() {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\x1b[?25h"); // 恢复光标
      if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\x1b[J`); // 清掉菜单帧
    }
    function onKey(str, key) {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolveP(null);
        return;
      }
      switch (key.name) {
        case "up": cursor = Math.max(0, cursor - 1); break;
        case "down": cursor = Math.min(suites.length - 1, cursor + 1); break;
        case "space": checked[cursor] = !checked[cursor]; break;
        case "a": {
          const on = !checked.every(Boolean);
          for (let i = 0; i < checked.length; i++) checked[i] = on;
          break;
        }
        case "return": case "enter": {
          cleanup();
          const sel = suites.filter((_, i) => checked[i]);
          resolveP(sel.length ? sel : null);
          return;
        }
        case "escape": case "q":
          cleanup();
          resolveP(null);
          return;
        default:
          return;
      }
      draw();
    }
    process.stdin.on("keypress", onKey);
    draw();
  });
}
