//! 微信小游戏包文件生成：data.js（全内存内联数据，CJS 出口）、game.js 入口、
//! game.json（屏幕方向）、project.config.json（appid 继承链 + condition 槽位）、
//! project.private.config.json（空 condition，防工具沿用脏的自定义编译条件）、
//! README.txt。全部为纯文本生成，无 IO（写盘由管线统一走 write_export_dir）。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::path::Path;

/// 游客模式 AppID（未注册身份；工具可打开模拟器，真机预览需真实 AppID）
pub(super) const TOURIST_APPID: &str = "touristappid";

/// 入口：唯一职责是装载预构建 bundle（adapter + player + engine + three）。
/// 入口体不做任何全局写入——开发者工具对入口体与模块提供独立全局视图，
/// 跨边界全局不可见，一切适配都在 bundle 单一模块作用域内完成。
pub(super) fn game_js() -> String {
    "// 由 TvE Hub 微信小游戏构建生成（请勿手动编辑）\nrequire(\"./code.js\");\n".to_string()
}

/// data.js：config + 全部资产（场景/材质/贴图/模型/音频，base64）单模块内联。
/// player 的 main() 读 window.__TVE_BUILD_DATA（适配层 data 桥从本模块 require 注入），
/// 资产全部经 AssetBundle 内存命中，零文件系统参与。
pub(super) fn data_js(
    config: serde_json::Map<String, serde_json::Value>,
    entries: &[(String, Vec<u8>)],
) -> Result<String, String> {
    let mut data = serde_json::Map::new();
    data.insert("config".to_string(), serde_json::Value::Object(config));
    let assets: serde_json::Map<String, serde_json::Value> = entries
        .iter()
        .map(|(rel, bytes)| (rel.clone(), serde_json::Value::String(BASE64.encode(bytes))))
        .collect();
    data.insert("assets".to_string(), serde_json::Value::Object(assets));
    let json = serde_json::Value::Object(data).to_string();
    Ok(format!("module.exports = {json};\n"))
}

/// game.json：屏幕方向由构建配置选择（portrait / landscape，缺省 portrait）
pub(super) fn game_json(orientation: &str) -> String {
    let orientation = match orientation {
        "landscape" => "landscape",
        _ => "portrait",
    };
    let value = serde_json::json!({
        "deviceOrientation": orientation,
        "showStatusBar": false,
        "networkTimeout": {
            "request": 10000,
            "connectSocket": 10000,
            "uploadFile": 10000,
            "downloadFile": 10000
        }
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
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
pub(super) fn project_config_json(project_name: &str, appid: &str) -> String {
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
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// project.private.config.json：condition 必须为空对象（清空自定义编译条件）
pub(super) fn project_private_config_json(project_name: &str) -> String {
    let value = serde_json::json!({
        "libVersion": "latest",
        "projectname": project_name,
        "setting": {},
        "condition": {}
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
}

/// README.txt：导入步骤 + 限制说明（包体积由微信开发者工具在发布/上传时判定，
/// 构建期不做限制）+ 工具缓存排障
pub(super) fn readme(appid: &str, orientation: &str) -> String {
    let effective = if appid == TOURIST_APPID {
        "touristappid（游客模式：可模拟器运行；真机预览需填入真实 AppID 后重新构建）"
    } else {
        "已在构建配置中显式填写"
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
- data.js            全内存数据（项目配置 + 场景 + 资产 base64 内联，运行期零文件系统）
- engine/core/tve.js 用户脚本 tve API 门面（转发 code.js）
- src/               用户脚本（CommonJS 编译产物）
- engine/runtime/physics-engines/rapier.js  物理引擎（启用物理的项目随包）

已知限制
--------
- 包体积：本构建不做限制，由微信开发者工具在预览/上传发布时按其规则判定
  （超限时工具会给出具体提示）；
- 物理：仅支持 rapier 后端（jolt/ammo 不随包）；Draco/Basis 压缩资产不支持
  （依赖 Worker，启用压缩的项目请关闭后重新构建）；
- Worker 类能力走主线程回退（动画/物理自动降级）；真机（iOS/Android）未在
  本渠道验证，请以开发者工具模拟器验收为准。
"#
    )
}
