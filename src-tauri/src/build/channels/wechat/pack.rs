//! 微信小游戏包文件生成：data.js（全内存内联数据，CJS 出口）、game.js 入口、
//! game.json（屏幕方向）、project.config.json（appid 继承链 + condition 槽位）、
//! project.private.config.json（空 condition，防工具沿用脏的自定义编译条件）、
//! README.txt。全部为纯文本生成，无 IO（写盘由管线统一走 write_export_dir）。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// 游客模式 AppID（未注册身份；工具可打开模拟器，真机预览需真实 AppID）
pub(super) const TOURIST_APPID: &str = "touristappid";

/// 真机诊断开关同步语句（audio-diag 的 __tveDiagOn storage 显式开关；盒中盒
/// 键位必须与 platforms/wechat storageGet 同模式）。diag=true 写 "1"，false
/// 删键——勾选框恒为权威态：上一轮开启后设备 storage 的残留会被下一次不勾选
/// 的导出自愈清掉，弹窗不会关不掉。入口体不做全局写入是原则，storage 是例外：
/// 平台 storage 是入口/模块互相隔离的全局视图之间唯一跨界面（V10 教训）。
fn diag_switch_js(diag: bool) -> &'static str {
    if diag {
        "try {
  var __tveBox = wx.getStorageSync(\"__tve_wx_local_storage__\") || {};
  if (__tveBox.__tveDiagOn !== \"1\") { __tveBox.__tveDiagOn = \"1\"; wx.setStorageSync(\"__tve_wx_local_storage__\", __tveBox); }
} catch (e) { /* storage 不可用按无诊断 */ }"
    } else {
        "try {
  var __tveBox = wx.getStorageSync(\"__tve_wx_local_storage__\");
  if (__tveBox && __tveBox.__tveDiagOn !== undefined) { delete __tveBox.__tveDiagOn; wx.setStorageSync(\"__tve_wx_local_storage__\", __tveBox); }
} catch (e) { /* storage 不可用按无诊断 */ }"
    }
}

/// 入口：先同步真机诊断开关（storage 平台通道，见 diag_switch_js），再装载
/// 预构建 bundle（adapter + player + engine + three）；启用分包时
/// 先并行预加载全部分包再进游戏——桥接层对资产是同步读契约（readFileSync），
/// 分包必须在游戏启动前就绪；单个分包加载失败不阻断启动，其内资产按缺失
/// 降级（readPackageFile 返回 null 走调用方降级链）。基础库 2.1.0 以下无
/// loadSubpackage，直接进游戏（分包资产缺失，控制台可见 404 告警）。
/// 入口体不做任何全局写入——开发者工具对入口体与模块提供独立全局视图，
/// 跨边界全局不可见，一切适配都在 bundle 单一模块作用域内完成。
pub(super) fn game_js(sub_roots: &[String], diag: bool) -> String {
    let diag_sync = diag_switch_js(diag);
    if sub_roots.is_empty() {
        return format!(
            "// 由 TvE Hub 微信小游戏构建生成（请勿手动编辑）\n{diag_sync}\nrequire(\"./code.js\");\n"
        );
    }
    let roots: Vec<serde_json::Value> = sub_roots
        .iter()
        .map(|r| serde_json::Value::String(r.clone()))
        .collect();
    format!(
        r#"// 由 TvE Hub 微信小游戏构建生成（请勿手动编辑）
{diag_sync}
(function (roots) {{
  var load = null;
  try {{
    if (typeof wx !== "undefined" && wx && typeof wx.loadSubpackage === "function") load = wx.loadSubpackage;
  }} catch (e) {{ /* 沙箱遮蔽时读 free 标识符可能抛错 */ }}
  if (!load) {{ require("./code.js"); return; }}
  var left = roots.length;
  var enter = function (root, err) {{
    if (err) console.warn("[TvE] 分包 " + root + " 加载失败（其内资产将按缺失降级）", err);
    left -= 1;
    if (left === 0) require("./code.js");
  }};
  for (var i = 0; i < roots.length; i++) {{
    (function (root) {{
      try {{
        load({{ name: root, success: function () {{ enter(root); }}, fail: function (res) {{ enter(root, res); }} }});
      }} catch (e) {{ enter(root, e); }}
    }})(roots[i]);
  }}
}})({roots});
"#,
        roots = serde_json::Value::Array(roots)
    )
}

/// data.js：config + 场景/小文本资产（base64 内联，热路径零 FS 读）+ 文件化资产
/// 清单（assetFiles：rel → 包内文件路径；二进制按原始字节落盘，不交 33% base64 税）。
/// player 的 main() 读 window.__TVE_BUILD_DATA（适配层 data 桥从本模块 require 注入）；
/// 桥接层查内联表 miss 时按清单经端点 readPackageFile 读字节。
pub(super) fn data_js(
    config: serde_json::Map<String, serde_json::Value>,
    entries: &[(String, Vec<u8>)],
    asset_files: &[(String, String)],
) -> Result<String, String> {
    let mut data = serde_json::Map::new();
    data.insert("config".to_string(), serde_json::Value::Object(config));
    let assets: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|(rel, bytes)| (rel.clone(), serde_json::Value::String(BASE64.encode(bytes))))
        .collect();
    data.insert("assets".to_string(), serde_json::Value::Object(assets));
    let files: serde_json::Map<String, serde_json::Value> = asset_files
        .iter()
        .map(|(rel, file)| (rel.clone(), serde_json::Value::String(file.clone())))
        .collect();
    data.insert("assetFiles".to_string(), serde_json::Value::Object(files));
    let json = serde_json::Value::Object(data).to_string();
    Ok(format!("module.exports = {json};\n"))
}

/// 资产文件化命名：rel → `assets/<fnv1a64(rel) 十六位><安全扩展名>`。
/// 确定性哈希（跨构建稳定）；扩展名取微信包白名单内的规范形，白名单外一律
/// `.bin`——消费侧按 rel 键分派加载器，不依赖文件扩展名；重名（哈希碰撞，
/// 理论事件）追加 `-2/-3` 序号（序号在扩展名之前）。
pub(super) fn asset_file_name(rel: &str, used: &mut HashSet<String>) -> String {
    let uid = crate::build::kernel::release::fallback_uid(rel);
    let ext = match rel.rsplit('.').next() {
        Some(e) => match e.to_ascii_lowercase().as_str() {
            "png" => ".png",
            "jpg" | "jpeg" => ".jpg",
            "gif" => ".gif",
            "webp" => ".webp",
            "mp3" => ".mp3",
            "wav" => ".wav",
            "ogg" => ".ogg",
            "m4a" => ".m4a",
            _ => ".bin",
        },
        None => ".bin",
    };
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("assets/{uid}{ext}")
        } else {
            format!("assets/{uid}-{n}{ext}")
        };
        if used.insert(name.clone()) {
            return name;
        }
        n += 1;
    }
}

/// game.json：屏幕方向由构建配置选择（portrait / landscape，缺省 portrait）；
/// with_workers = 物理 Worker bundle 实际随包时声明 workers 字段（wx.createWorker
/// 依赖该声明；声明而无目录会令开发者工具编译失败，故按实际随包条件写入）；
/// sub_roots 非空时声明 subpackages 字段（root 与 name 同值，wx.loadSubpackage
/// 按 name 加载，同值消除两种指称的歧义）
pub(super) fn game_json(
    orientation: &str,
    with_workers: bool,
    sub_roots: &[String],
) -> Result<String, String> {
    let orientation = match orientation {
        "landscape" => "landscape",
        _ => "portrait",
    };
    let mut value = serde_json::json!({
        "deviceOrientation": orientation,
        "showStatusBar": false,
        "networkTimeout": {
            "request": 10000,
            "connectSocket": 10000,
            "uploadFile": 10000,
            "downloadFile": 10000
        }
    });
    let obj = value
        .as_object_mut()
        .ok_or_else(|| "game.json 结构异常".to_string())?;
    if with_workers {
        obj.insert("workers".to_string(), serde_json::Value::String("workers".to_string()));
    }
    if !sub_roots.is_empty() {
        let packages: Vec<serde_json::Value> = sub_roots
            .iter()
            .map(|r| serde_json::json!({ "root": r, "name": r }))
            .collect();
        obj.insert("subpackages".to_string(), serde_json::Value::Array(packages));
    }
    serde_json::to_string_pretty(&value).map_err(|e| format!("game.json 序列化失败: {e}"))
}

/// 分包入口桩：微信要求每个分包根目录必须含 game.js（开发者工具静态校验
/// 「未找到 root 对应的 game.js」直接报错；分包加载完成后该文件会被执行），
/// 资产分包无代码，落注释桩即可（桩在分包上下文执行，不写任何全局）。
pub(super) fn subpackage_game_js() -> String {
    "// TvE Hub 分包入口（本分包只含资产文件，无代码；微信要求分包根目录含 game.js）\n"
        .to_string()
}

/// 二进制资产分包装箱：按 rel 序贪心填入 pkg-1、pkg-2…（确定性布局：同输入同
/// 分包，跨构建稳定）。单个超限资产独占一个分包，不阻断构建（体积限制由开发
/// 者工具在预览/上传时判定）。就地为 asset_files 的包内路径加分包前缀，返回
/// 分包 root 列表（game.json 声明 + game.js 预加载）。
pub(super) fn split_into_subpackages(
    asset_files: &mut [(String, String)],
    binaries: &HashMap<String, Vec<u8>>,
    limit_mb: u32,
) -> Vec<String> {
    let limit = (limit_mb as usize) * 1024 * 1024;
    let mut roots: Vec<String> = Vec::new();
    let mut cur_root = String::new();
    let mut cur_size = 0usize;
    for (rel, file) in asset_files.iter_mut() {
        let size = binaries.get(rel).map(|b| b.len()).unwrap_or(0);
        // 当前箱非空且再装一件将超限 → 开新箱（超限单件独占新箱，不拆文件）
        if !cur_root.is_empty() && cur_size > 0 && cur_size + size > limit {
            cur_root = String::new();
        }
        if cur_root.is_empty() {
            cur_root = format!("pkg-{}", roots.len() + 1);
            roots.push(cur_root.clone());
            cur_size = 0;
        }
        cur_size += size;
        *file = format!("{cur_root}/{file}");
    }
    roots
}

/// project.config.json 的 condition 槽位结构（照官方 quickstart——工程按小游戏
/// 模式编译必需，否则工具可能沿用脏的自定义编译条件按小程序模式跑）
fn condition_slots() -> serde_json::Value {
    serde_json::json!({
        "search": { "current": -1, "list": [] },
        "conversation": { "current": -1, "list": [] },
        "game": { "current": -1, "list": [] },
        "miniprogram": { "current": -1, "list": [] }
    })
}

/// appid 继承链：显式填写 > 上次产物 project.config.json 里的 appid（工具会把它
/// 绑定到工程身份，改写会导致工程身份不一致黑屏）> touristappid（游客模式）
pub(super) fn resolve_appid(explicit: Option<&str>, out_dir: &Path) -> String {
    if let Some(appid) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return appid.to_string();
    }
    let previous = std::fs::read_to_string(out_dir.join("project.config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get("appid").and_then(|a| a.as_str()).map(str::to_string))
        .filter(|s| !s.is_empty());
    previous.unwrap_or_else(|| TOURIST_APPID.to_string())
}

/// project.config.json：compileType=game + appid + condition 槽位
pub(super) fn project_config_json(project_name: &str, appid: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "description": "由 TvE Hub 微信小游戏构建生成（appid 变更后需在开发者工具重新导入工程）",
        "setting": {
            "urlCheck": false,
            "es6": true,
            "postcss": true,
            "minified": true,
            "newFeature": true,
            "uglifyFileName": false,
            "uploadWithSourceMap": true,
            "enhance": false,
            "packNpmManually": false,
            "packNpmRelationList": [],
            "minifyWXSS": true,
            "localPlugins": false,
            "condition": false,
            "compileWorklet": false,
            "babelSetting": { "ignore": [], "disablePlugins": [], "outputPath": "" },
            "disableUseStrict": false,
            "minifyWXML": true,
            "useCompilerPlugins": false
        },
        "compileType": "game",
        "libVersion": "latest",
        "appid": appid,
        "projectname": project_name,
        "condition": condition_slots(),
        "simulatorPluginLibVersion": {},
        "packOptions": { "ignore": [], "include": [] },
        "isGameTourist": appid == TOURIST_APPID,
        "editorSetting": {}
    });
    serde_json::to_string_pretty(&value).map_err(|e| format!("project.config.json 序列化失败: {e}"))
}

/// project.private.config.json：condition 必须为空对象（清空自定义编译条件）
pub(super) fn project_private_config_json(project_name: &str) -> Result<String, String> {
    let value = serde_json::json!({
        "libVersion": "latest",
        "projectname": project_name,
        "setting": {},
        "condition": {}
    });
    serde_json::to_string_pretty(&value)
        .map_err(|e| format!("project.private.config.json 序列化失败: {e}"))
}

/// README.txt：导入步骤 + 限制说明（包体积由微信开发者工具在发布/上传时判定，
/// 构建期不做限制）+ 工具缓存排障；分包启用时追加分包结构说明
pub(super) fn readme(appid: &str, orientation: &str, sub_roots: &[String]) -> String {
    let effective = if appid == TOURIST_APPID {
        "touristappid（游客模式：可模拟器运行；真机预览需填入真实 AppID 后重新构建）"
    } else {
        "已在构建配置中显式填写"
    };
    let sub_section = if sub_roots.is_empty() {
        String::new()
    } else {
        let list = sub_roots.join("、");
        format!(
            r#"- pkg-N/            分包（{list}）：文件化二进制资产按体积分箱移出主包
  （主包 4MB 限制的解法）；每个分包根目录含入口 game.js 桩（微信要求）；game.js
  在启动前并行预加载全部分包后才进游戏，单个分包加载失败不阻断启动（其内资产
  按缺失降级，控制台有告警行）；场景与小文本资产仍在主包 data.js 内
"#
        )
    };
    format!(
        r#"TvE Hub 微信小游戏构建产物
=============================

导入方式
--------
1. 打开「微信开发者工具」，选择「小游戏」→「导入项目」；
2. 目录选择本文件夹（build/wechat），AppID 使用 {effective}；
3. 首次导入或构建产物更新后出现异常（白屏/旧报错），先清除编译缓存：
   设置 → 通用 → 清除缓存 → 勾选「编译缓存」，或关闭项目窗口后重新打开。

产物结构
--------
- game.js / game.json / project.config.json  工程入口与配置（屏幕方向：{orientation}）
- code.js            预构建运行时（微信适配层 + player + 引擎 + three，单文件 CJS）
- data.js            构建数据（config + 场景/小文本资产 base64 内联 + 二进制资产
                     的文件化清单 assetFiles）
- assets/            文件化二进制资产（贴图/模型/音频，原始字节；运行期经清单
                     + FileSystemManager 读取，不交 base64 税）
{sub_section}- engine/core/tve.js 用户脚本 tve API 门面（转发 code.js）
- src/               用户脚本（CommonJS 编译产物）
- engine/runtime/physics-engines/  物理引擎（启用物理的项目按后端随包：
  rapier/jolt/ammo 的胶水 .js + .wasm 文件）
- workers/tve.js     物理 Worker（启用物理的项目随包：物理模拟在独立线程运行，
  wasm 字节经主线程读包回传实例化；game.json 已声明 workers 字段）
- engine/runtime/loaders/meshopt_decoder.wasm  meshopt 解码（GLTFLoader 依赖）

已知限制
--------
- 包体积：本构建不做限制，由微信开发者工具在预览/上传发布时按其规则判定
  （主包 4MB；启用分包时单个分包体积按构建配置分箱，总包上限以微信平台
  当前规则为准）；
- 资产文件化：二进制资产以白名单扩展名（png/jpg/gif/webp/mp3/wav/ogg/m4a）
  或 .bin 落盘，首次导出后请在工具确认包内文件齐全（工具对陌生扩展名会
  静默剔除，.bin 兜底应可规避）；
- 物理：rapier/jolt/ammo 三后端均支持——wasm 以代码包内 .wasm 文件随包，主
  线程由桥接层经 WXWebAssembly.instantiate(路径) 实例化，Worker 线程经字节
  中继以原生 WebAssembly 实例化；物理模拟默认跑在 Worker 线程（平台不支持
  或 Worker 就绪失败时自动回退主线程，控制台有告警行）；Draco 压缩已支持
  （主线程内联解码）；Basis 纹理压缩不支持（请关闭后重新构建）；
- 真机（iOS/Android）的 Worker 线程与 wasm 物理未经实机验证，请以开发者
  工具模拟器验收为准，真机异常时留意控制台 [runtime-bridge]/[物理] 告警行。
"#
    )
}
