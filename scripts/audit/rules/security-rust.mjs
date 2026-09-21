// ---------------------------------------------------------------------------
// 安全规则 · Rust 后端面：路径穿越（越权读文件）、命令执行、SSRF、反序列化、
// panic 通道（block_on/unwrap）、密钥外泄日志。web 暴露面（lanshare / preview /
// asset_protocol / repos）的文件读取必须经 resolve_in_root 或受控根。
// ---------------------------------------------------------------------------
import { makeFinding } from "../lib/finding.mjs";
import { rsNonTestOf } from "../lib/collect.mjs";

const WEB_EXPOSED = /src-tauri\/src\/(lanshare\/|preview\.rs|asset_protocol\.rs|repos\.rs)/;
// 本仓库已确立的守卫词汇（复核后白名单化：resolve_in_root/safe_rel/safe_segment/
// starts_with 二次校验/固定 app 目录函数等）。同一行或上文 3 行内出现即视为受守卫。
const GUARD = /resolve_in_root|canonicalize|sanitize_name|safe_rel|safe_segment|starts_with|internal_root|config_path|sites_dir|site_dir|staging|write_export_file|app_data|base_dir|out_dir|root/;
/** 固定 argv 的进程创建（当前 exe 自重启/ipconfig 构网信息）走台账，规则只拦拼接；
 *  线程/任务 spawn（std::thread / spawn_blocking）不是进程创建，不算 */
const EXEC_CALL = /Command::new\s*\(|process::Command/;

export function scanSecurityRust(files) {
  const out = [];
  for (const f of files) {
    if (f.kind !== "rs") continue;
    if (/(^|\/)(tests|benches)\.rs$/.test(f.rel)) continue; // 测试文件不进安全规则面
    const lines = rsNonTestOf(f);
    lines.forEach((ln, i) => {
      const num = i + 1;
      const ctx = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      // 1) web 暴露面里未走守卫的文件读写 → 越权/穿越候选，人工复核后入台账
      if (WEB_EXPOSED.test(f.rel) && /(fs::read|read_to_string|File::open|fs::write|fs::create_dir|fs::remove)/.test(ln) && !GUARD.test(ctx)) {
        out.push(makeFinding({
          rule: "trav.unguarded-fs", dimension: "security", category: "越权/路径穿越",
          severity: "high", file: f.rel, line: num, snippet: ln,
          message: "Web 暴露面内的文件读写：该行未见 resolve_in_root/受控根守卫，需人工复核数据流",
          fix: "确认路径来源全部经 resolve_in_root(root, rel) 收敛后，入台账接受",
        }));
      }
      // 2) 命令执行（只认实际创建调用：use 导入行与 process::id/exit 不算）
      if (EXEC_CALL.test(ln) && !/^\s*use\s/.test(ln)) {
        out.push(makeFinding({
          rule: "exec.command", dimension: "security", category: "命令注入",
          severity: "high", file: f.rel, line: num, snippet: ln,
          message: "进程创建调用：参数必须与用户输入隔离（无 shell 拼接）",
          fix: "固定 argv，禁 format! 拼接；确需执行则入台账",
        }));
      }
      // 3) block_on 于 async fn 体内（tokio 工作线程上 panic/死锁；本仓库的既定
      //    修法：整段挪 spawn_blocking —— 见 *_blocking 包装函数模式）。同步 fn
      //    内的 block_on（spawn_blocking/独立线程调用）合法，降为 info 备查。
      if (/block_on\s*\(/.test(ln) && !/^\s*\/\/|^\s*use\s/.test(ln)) {
        let k = i;
        let enclosingAsync = false;
        let checked = 0;
        while (k >= 0 && checked < 60) {
          const fl = lines[k];
          if (/\bfn\s+\w/.test(fl)) {
            enclosingAsync = /\basync\s+fn\b/.test(fl);
            break;
          }
          k -= 1;
          checked += 1;
        }
        if (enclosingAsync) {
          out.push(makeFinding({
            rule: "panic.block-on-async", dimension: "security", category: "稳定性/Panic",
            severity: "critical", file: f.rel, line: num, snippet: ln,
            message: "async fn 体内 block_on：tokio 工作线程上直接 panic/死锁",
            fix: "整段挪 spawn_blocking（参考 devtools internal_call_blocking 模式）",
          }));
        }
      }
      // 4) unwrap/expect 于非测试代码（panic 通道，Major 不破防线但必须跟踪）
      if (/\.unwrap\(\)|\.expect\(/.test(ln) && !/^[^/]*\/\//.test(ln.replace(/".*"/g, ""))) {
        out.push(makeFinding({
          rule: "panic.unwrap", dimension: "quality", category: "异常处理",
          severity: "major", file: f.rel, line: num, snippet: ln,
          message: "非测试代码使用 unwrap/expect：panic 会击穿 Tauri 命令边界",
          fix: "改 ? / map_err 传播；初始化期确属不变量的入台账",
        }));
      }
      // 5) 密钥外泄日志
      if (/(println!|eprintln!|print!|log::|tracing::|info!|debug!|warn!|error!)/.test(ln) && /(api_?key|secret|token|password|bearer)/i.test(ln)) {
        out.push(makeFinding({
          rule: "secret.key-logging", dimension: "security", category: "敏感数据泄露",
          severity: "high", file: f.rel, line: num, snippet: ln,
          message: "日志语句中出现密钥类字段名：确认未打印值本体",
          fix: "只记长度/指纹；确未泄值则入台账",
        }));
      }
      // 6) SSRF：外呼 URL 来自可配置变量（桌面应用用户自配端点，设计内 → info）
      if (/(Client::new|reqwest::|\.get\s*\(|\.post\s*\()/i.test(ln)) {
        const ctx = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
        if (/(base_url|url|endpoint)/i.test(ctx) && /format!|push_str| \+ /.test(ctx)) {
          out.push(makeFinding({
            rule: "ssrf.url-concat", dimension: "security", category: "SSRF",
            severity: "info", file: f.rel, line: num, snippet: ln,
            message: "外呼 URL 由变量拼接：桌面应用内用户自配端点属设计内，保持禁内网直连默认值",
            fix: "设计内 → 台账接受",
          }));
        }
      }
      // 7) 反序列化网络数据（serde 无多态 gadget 风险，损毁即拒 → info 备查）
      if (/serde_json::from_(str|slice|value|reader)/.test(ln) && /reqwest|stream|response|sse|chunk/i.test(lines.slice(Math.max(0, i - 10), i + 3).join("\n"))) {
        out.push(makeFinding({
          rule: "deser.network", dimension: "security", category: "反序列化",
          severity: "info", file: f.rel, line: num, snippet: ln,
          message: "对网络来源数据做 JSON 反序列化：serde 非多态反序列化，失败即拒，风险受控",
          fix: "备查即可",
        }));
      }
      // 8) lanshare 写操作端点（CSRF 面）：POST/PUT/DELETE 必须带令牌
      if (/src-tauri\/src\/lanshare/.test(f.rel) && /"POST"|"PUT"|"DELETE"|"PATCH"/.test(ln)) {
        out.push(makeFinding({
          rule: "csrf.mutating-endpoint", dimension: "security", category: "CSRF",
          severity: "critical", file: f.rel, line: num, snippet: ln,
          message: "LAN HTTP 服务出现写方法：必须校验 unlock 令牌/同源，否则任意局域网页可驱动",
          fix: "写操作统一走令牌校验中间层",
        }));
      }
    });
  }
  return out;
}
