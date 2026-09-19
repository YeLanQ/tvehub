// ---------------------------------------------------------------------------
// 应用目录解析（便携式）：release 下应用产生的数据/缓存随 exe 走（exe 同级
// data/），exe 目录不可写（如 Program Files）或 dev 构建回退系统目录
// （app_config_dir / WebView2 默认路径）。
// 统一收口：store（recent/prefs）、ui_state、devtools 权限、debug.log 与
// WebView2 浏览器数据目录都经此取路径，保证全部写入点用同一份便携判定。
// 旧系统目录数据的迁移见 migrate_legacy_config（setup 阶段一次性执行）。
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// exe 所在目录（current_exe 失败回退 "."）
pub(crate) fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 便携数据根目录判定（进程内只探测一次，配置与 WebView 数据共用同一结论）：
/// - dev 构建：None（开发态数据落系统 app_config_dir，不污染 target/）；
/// - release：exe 同级 data/ 可写 → Some(data/)；不可写 → None（回退系统目录）。
fn portable_root() -> Option<&'static PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        if cfg!(debug_assertions) {
            return None;
        }
        let dir = exe_dir().join("data");
        // 可写性探测：建目录 + 建删测试文件（配置写入与 WebView2 数据目录都依赖可写）
        std::fs::create_dir_all(&dir).ok()?;
        let probe = dir.join(".write-probe");
        std::fs::File::create(&probe).ok()?;
        std::fs::remove_file(&probe).ok()?;
        Some(dir)
    })
    .as_ref()
}

/// 应用配置根目录（recent/prefs/ui-state/devtools 权限/debug.log 的父目录）：
/// 便携模式 = exe 同级 data/；否则 app_config_dir（Windows 即 %APPDATA%\TvE.Hub）。
pub fn config_root(app: &AppHandle) -> PathBuf {
    match portable_root() {
        Some(d) => d.clone(),
        None => app
            .path()
            .app_config_dir()
            .unwrap_or_else(|_| PathBuf::from(".")),
    }
}

/// WebView2 浏览器数据目录（HTTP 缓存/着色器缓存/origin 存储等，随窗口
/// builder.data_directory 指定）：便携模式 = data/webview/；否则 None
/// （不指定，走 WebView2 默认 —— Windows 上为 %LOCALAPPDATA%\TvE.Hub）。
pub fn webview_data_dir() -> Option<PathBuf> {
    portable_root().map(|d| d.join("webview"))
}

/// 旧系统目录 → 便携目录的一次性迁移（setup 阶段调用）：旧 app_config_dir
/// 存在且便携目录尚无配置数据时整体复制。WebView2 浏览器缓存不迁移
/// （可再生且体积大，%LOCALAPPDATA% 旧缓存留待用户自行清理）。
/// 仅便携模式生效；dev 与回退模式数据本来就在系统目录，无需迁移。
pub fn migrate_legacy_config(app: &AppHandle) {
    let Some(dest) = portable_root() else {
        return;
    };
    let Ok(src) = app.path().app_config_dir() else {
        return;
    };
    if !src.is_dir() || src == *dest {
        return;
    }
    // 目标已有配置数据（prefs/recent/ui-state 任一）视为已迁移或已有数据，跳过
    if dest.join("prefs.json").exists()
        || dest.join("recent_projects.json").exists()
        || dest.join("ui-state").is_dir()
    {
        return;
    }
    let _ = copy_dir_recursive(&src, dest);
}

/// 递归复制目录（文件覆盖，目录合并；目标根目录不存在则创建）
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            std::fs::create_dir_all(&to)?;
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::copy_dir_recursive;

    #[test]
    fn copies_files_and_subdirs() {
        let base = std::env::temp_dir().join(format!("tve-appdirs-test-{}", std::process::id()));
        let src = base.join("src");
        let dest = base.join("dest");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(src.join("ui-state")).unwrap();
        std::fs::write(src.join("prefs.json"), "{}").unwrap();
        std::fs::write(src.join("ui-state").join("a.json"), "1").unwrap();
        copy_dir_recursive(&src, &dest).unwrap();
        assert_eq!(
            std::fs::read_to_string(dest.join("prefs.json")).unwrap(),
            "{}"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("ui-state").join("a.json")).unwrap(),
            "1"
        );
        std::fs::remove_dir_all(&base).unwrap();
    }
}
