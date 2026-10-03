//! 单页产物组装：运行时代码全部内联进入口页——相对 import 重写为 tve: 裸说明符，
//! 数据脚本 + 引导脚本注入 HTML（模板 {{BUILD_DATA}} 占位或 </body> 前回退）。

use std::collections::HashMap;

use crate::build::archive::inline_data_script;
use crate::build::classify::is_entry_page;
use crate::build::specifiers::rewrite_module_imports;
use crate::build::urls::three_cdn_remap;

/// 单页引导脚本：从内联数据取运行时代码（非 gzip 的 code 字段，或 gzip 归档里的
/// player.mjs/engine/** 条目），为每个模块生成 Blob URL 并注入 import map
/// （tve:<相对路径> → blob:），最后动态 import 入口 player.mjs。
/// 必须放在内联数据脚本之后、且页面没有任何模块脚本加载之前执行
const SINGLE_PAGE_BOOTSTRAP: &str = r#"<script>
(function () {
  var data = window.__TVE_BUILD_DATA;
  if (!data) return;
  var entry = "player.mjs";
  function fail(msg) {
    console.error(msg);
    var el = document.getElementById("error");
    if (el) {
      el.textContent = "单页运行时加载失败: " + msg;
      el.classList.add("visible");
    }
  }
  function boot(code) {
    if (!Object.prototype.hasOwnProperty.call(code, entry))
      return fail("缺少入口模块 " + entry);
    var imports = {};
    for (var rel in code)
      imports["tve:" + rel] = URL.createObjectURL(
        new Blob([code[rel]], { type: "text/javascript" })
      );
    var map = document.createElement("script");
    map.type = "importmap";
    map.textContent = JSON.stringify({ imports: imports });
    document.head.appendChild(map);
    import("tve:" + entry).catch(function (e) {
      fail(e && e.message ? e.message : String(e));
    });
  }
  try {
    if (data.code) {
      boot(data.code);
    } else if (data.pak) {
      var bin = atob(data.pak), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
      )
        .arrayBuffer()
        .then(function (buf) {
          var view = new DataView(buf), off = 0, dec = new TextDecoder();
          var count = view.getUint32(off, true); off += 4;
          var code = {};
          while (count-- > 0) {
            var pl = view.getUint32(off, true); off += 4;
            var path = dec.decode(new Uint8Array(buf, off, pl)); off += pl;
            var dl = view.getUint32(off, true); off += 4;
            // engine/ 二进制（.wasm）按字节走资产表（player 侧解 pak 供 fetch 垫片），
            // 不文本化解码成 blob 模块
            if (
              (path === entry ||
                ((path.lastIndexOf("engine/", 0) === 0 ||
                  path.lastIndexOf("src/", 0) === 0) &&
                  !/\.wasm$/.test(path)))
            )
              code[path] = dec.decode(new Uint8Array(buf, off, dl));
            off += dl;
          }
          boot(code);
        })
        .catch(function (e) { fail(String(e)); });
    }
  } catch (e) { fail(String(e)); }
})();
</script>"#;

/// 移除入口页里引用 player.mjs 的 <script> 标签（单页模式代码已内联，原标签会 404）
fn strip_player_script_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(start) = rest.find("<script") {
        let tail = &rest[start..];
        let Some(end) = tail.find("</script") else {
            break;
        };
        let seg_end = start + end + "</script".len();
        if !tail[..end].contains("player.mjs") {
            result.push_str(&rest[..seg_end]);
        }
        rest = &rest[seg_end..];
    }
    result.push_str(rest);
    result
}

/// 单页组装：把运行时代码里的相对 import 重写为 tve: 裸说明符（CDN 模式下
/// three 不在代码表，其相对说明符直接重写为 CDN 绝对 URL），数据脚本 + 引导
/// 脚本注入全部入口页（模板可用 {{BUILD_DATA}} 占位指定注入位置，无占位符时
/// 回退注入 </body> 前；config 不落盘）。返回内联代码条数（gzip 资产数修正用）。
pub(super) fn assemble_single_page(
    files: &mut HashMap<String, String>,
    entries: &mut Vec<(String, Vec<u8>)>,
    cfg: serde_json::Map<String, serde_json::Value>,
    three_base: &str,
    cdn_active: bool,
    gzip: bool,
) -> Result<usize, String> {
    let mut pages: HashMap<String, String> = HashMap::new();
    let mut code: HashMap<String, String> = HashMap::new();
    for (rel, text) in files.drain() {
        if is_entry_page(&rel) {
            pages.insert(rel, text);
        } else {
            code.insert(rel, text);
        }
    }
    let cdn_remap = three_cdn_remap(three_base);
    let empty_remap: HashMap<String, String> = HashMap::new();
    rewrite_module_imports(&mut code, if cdn_active { &cdn_remap } else { &empty_remap });
    let code_n = code.len();
    let script = if gzip {
        for (rel, text) in &code {
            entries.push((rel.clone(), text.clone().into_bytes()));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        inline_data_script(cfg, entries, true, None)?
    } else {
        inline_data_script(cfg, entries, false, Some(&code))?
    };
    let inject = format!("{script}\n{SINGLE_PAGE_BOOTSTRAP}");
    for html in pages.values_mut() {
        let clean = strip_player_script_tags(html);
        *html = if clean.contains("{{BUILD_DATA}}") {
            clean.replacen("{{BUILD_DATA}}", &inject, 1)
        } else if clean.contains("</body>") {
            clean.replacen("</body>", &format!("{inject}\n</body>"), 1)
        } else {
            format!("{clean}\n{inject}")
        };
    }
    *files = pages;
    Ok(code_n)
}
