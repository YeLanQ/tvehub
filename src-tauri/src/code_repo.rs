// ---------------------------------------------------------------------------
// 代码工坊脚本原型：public/repos/code/*.ts，一个原型一个独立文件。
// - 文件名（去 .ts）即原型名（如 Spin.ts → 原型 "Spin"）；
// - 首行可用 "// @desc: 描述" 声明描述（列表时带回；缺省为空）；
// - 代码支持 {{CLASS_NAME}} 占位符（创建脚本时注入类名）；
// - 目录定位与内置资源同源（builtin_root）：开发 = 仓库 public/repos/code，
//   生产 = exe 同级 public/repos/code（用户文件写 exe 旁，不随构建覆盖）。
// ---------------------------------------------------------------------------

use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use crate::code_repo_root;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeProtoInfo {
    /// 文件名（含 .ts，如 "Spin.ts"）
    pub file: String,
    /// 原型名（文件名去 .ts）
    pub name: String,
    /// 首行 // @desc: 的描述（缺省空字符串）
    pub description: String,
}

fn code_repo_dir() -> Result<PathBuf, String> {
    let root = code_repo_root();
    fs::create_dir_all(&root).map_err(|e| format!("创建原型目录失败: {e}"))?;
    Ok(root)
}

/// 文件名守卫：仅允许以 .ts 结尾、不含路径分隔符与 ..（防越界）
fn safe_proto_file(file: &str) -> Option<String> {
    let f = file.trim();
    if !f.ends_with(".ts") || f.len() <= 3 {
        return None;
    }
    if f.contains('\\') || f.contains('/') || f.contains("..") {
        return None;
    }
    Some(f.to_string())
}

/// 从代码首行注释解析描述（// @desc: xxx，支持全角冒号）
fn parse_desc(code: &str) -> String {
    for line in code.lines().take(5) {
        let t = line.trim();
        for p in ["// @desc:", "// @desc："] {
            if let Some(rest) = t.strip_prefix(p) {
                return rest.trim().to_string();
            }
        }
    }
    String::new()
}

/// 扫描原型目录（*.ts，按文件名排序）。
/// 目录首次创建（不存在）时播种内置基础脚本模板为普通文件「基础脚本.ts」，
/// 之后与任意用户原型一视同仁（可编辑/删除，不再有内置特例）。
#[tauri::command]
pub async fn list_code_protos() -> Result<Vec<CodeProtoInfo>, String> {
    let root = code_repo_dir()?;
    let mut names: Vec<String> = fs::read_dir(&root)
        .map_err(|e| format!("读取原型目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".ts"))
        .collect();
    names.sort();
    // 空目录时播种内置基础脚本模板为普通文件，保证工坊永远有可用起点
    if names.is_empty() {
        let tpl = crate::internal_root().join("templates/Script.ts");
        if let Ok(code) = fs::read_to_string(&tpl) {
            if fs::write(root.join("基础脚本.ts"), code).is_ok() {
                names.push("基础脚本.ts".to_string());
            }
        }
    }
    let mut out = Vec::with_capacity(names.len());
    for f in names {
        let code = fs::read_to_string(root.join(&f)).unwrap_or_default();
        out.push(CodeProtoInfo {
            name: f.trim_end_matches(".ts").to_string(),
            file: f,
            description: parse_desc(&code),
        });
    }
    Ok(out)
}

/// 读取原型文件内容（file 含 .ts）
#[tauri::command]
pub async fn read_code_proto(file: String) -> Result<String, String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = code_repo_dir()?.join(&f);
    if !path.is_file() {
        return Err(format!("原型文件不存在: {f}"));
    }
    fs::read_to_string(&path).map_err(|e| format!("读取原型失败 '{f}': {e}"))
}

/// 写入原型文件（新建/整表覆盖；目录不存在自动创建）
#[tauri::command]
pub async fn write_code_proto(file: String, code: String) -> Result<(), String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = code_repo_dir()?.join(&f);
    fs::write(&path, code).map_err(|e| format!("写入原型失败 '{f}': {e}"))
}

/// 删除原型文件
#[tauri::command]
pub async fn delete_code_proto(file: String) -> Result<(), String> {
    let f = safe_proto_file(&file).ok_or_else(|| format!("非法原型文件名: {file}"))?;
    let path = code_repo_dir()?.join(&f);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("删除原型失败 '{f}': {e}"))?;
    }
    Ok(())
}
