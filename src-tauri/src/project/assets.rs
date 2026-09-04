use std::fs;
use std::path::{Path, PathBuf};

use super::path::resolve_in_root;
use super::{copy_meta_sibling, ensure_meta, refresh_meta_uuid, sibling_with_meta};

/// 复制资产（文件或目录，目录递归复制）到同目录下不冲突的新名字，返回新资产相对路径。
/// 源资产带 `.meta` 会一并复制并重新生成 uuid，避免与源冲突。
pub fn copy_asset(root: &Path, rel: &str) -> Result<String, String> {
    let root_abs = root.canonicalize().map_err(|e| format!("无法解析项目目录: {}", e))?;
    let src = resolve_in_root(&root_abs, rel)?;
    if !src.exists() {
        return Err(format!("资产不存在: {}", rel));
    }
    let parent = src
        .parent()
        .ok_or_else(|| "不能复制项目根目录".to_string())?;
    let fname = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "非法资产名".to_string())?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| fname.clone());
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut n = 0;
    let dest = loop {
        n += 1;
        let suffix = if n == 1 { " copy".to_string() } else { format!(" copy {n}") };
        let candidate = parent.join(format!("{stem}{suffix}{ext}"));
        if !candidate.exists() {
            break candidate;
        }
    };

    if src.is_dir() {
        copy_tree(&src, &dest)?;
    } else {
        fs::copy(&src, &dest).map_err(|e| format!("复制失败 '{}': {}", rel, e))?;
    }
    copy_meta_sibling(&src, &dest)?;
    ensure_meta(&dest)?;

    let new_rel = dest
        .strip_prefix(&root_abs)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(new_rel)
}

/// 递归复制目录/文件；复制 `.meta` 时重新生成其中的 uuid。
pub fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("创建目录失败: {}", e))?;
        let rd = fs::read_dir(src).map_err(|e| e.to_string())?;
        for entry in rd.flatten() {
            let p = entry.path();
            copy_tree(&p, &dest.join(entry.file_name()))?;
        }
    } else {
        fs::copy(src, dest).map_err(|e| format!("复制失败 '{}': {}", src.display(), e))?;
        if src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("meta"))
            .unwrap_or(false)
        {
            refresh_meta_uuid(dest)?;
        }
    }
    Ok(())
}

/// 导入外部文件/目录到项目内指定目录（dest_dir 相对项目根）。同名自动加数字后缀。
pub fn import_assets(root: &Path, dest_dir: &str, source_paths: &[String]) -> Result<Vec<String>, String> {
    if dest_dir.trim() == "src" || dest_dir.trim().starts_with("src/") {
        return Err("不能在 src 目录导入资产（脚本目录）".to_string());
    }
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {}", e))?;
    let dest = resolve_in_root(&root_abs, dest_dir)?;
    fs::create_dir_all(&dest).map_err(|e| format!("创建目标目录失败: {}", e))?;
    let mut imported = Vec::new();
    for src_path in source_paths {
        let src = PathBuf::from(src_path);
        if !src.exists() {
            continue;
        }
        let fname = match src.file_name() {
            Some(s) => s.to_string_lossy().to_string(),
            None => continue,
        };
        let dest_file = unique_dest_path(&dest, &fname);
        if src.is_dir() {
            copy_tree(&src, &dest_file)?;
        } else {
            fs::copy(&src, &dest_file)
                .map_err(|e| format!("导入失败 '{}': {}", fname, e))?;
        }
        copy_meta_sibling(&src, &dest_file)?;
        ensure_meta(&dest_file)?;
        let rel = dest_file
            .strip_prefix(&root_abs)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        imported.push(rel);
    }
    Ok(imported)
}

/// 在 dest 目录下找不冲突的文件名：name.ext → name_1.ext → name_2.ext…
pub fn unique_dest_path(dest: &Path, fname: &str) -> PathBuf {
    let candidate = dest.join(fname);
    if !candidate.exists() {
        return candidate;
    }
    let path = PathBuf::from(fname);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| fname.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 1;
    loop {
        let candidate = dest.join(format!("{stem}_{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

/// 移动资产（文件/目录）到项目内另一目录（dest_dir 相对项目根），返回新资产相对路径。
pub fn move_asset(root: &Path, rel: &str, dest_dir: &str) -> Result<String, String> {
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {}", e))?;
    let src = resolve_in_root(&root_abs, rel)?;
    if !src.exists() {
        return Err(format!("资产不存在: {}", rel));
    }
    if dest_dir.trim().is_empty() {
        return Err("目标目录为空".to_string());
    }
    let dest = resolve_in_root(&root_abs, dest_dir)?;
    let fname = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "非法资产名".to_string())?;
    let src_parent = src.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let dest_canon = dest.canonicalize().unwrap_or_else(|_| dest.clone());
    if dest_canon == src_parent.canonicalize().unwrap_or(src_parent) {
        return Ok(rel.to_string());
    }
    let src_canon = src.canonicalize().unwrap_or_else(|_| src.clone());
    if dest_canon.starts_with(&src_canon) {
        return Err(format!("不能把 '{}' 移入其子目录", rel));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let dest_file = unique_dest_path(&dest, &fname);
    if fs::rename(&src, &dest_file).is_err() {
        if src.is_dir() {
            copy_tree(&src, &dest_file)?;
        } else {
            fs::copy(&src, &dest_file)
                .map_err(|e| format!("移动失败 '{}': {}", fname, e))?;
        }
        delete_asset(&root_abs, rel)?;
    }
    let meta_src = sibling_with_meta(&src);
    if meta_src.is_file() {
        let meta_dest = sibling_with_meta(&dest_file);
        if fs::rename(&meta_src, &meta_dest).is_err() {
            let _ = fs::copy(&meta_src, &meta_dest);
            let _ = fs::remove_file(&meta_src);
        }
    }
    ensure_meta(&dest_file)?;
    let new_rel = dest_file
        .strip_prefix(&root_abs)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(new_rel)
}

/// 删除资产（文件或目录，目录递归删除）；带的 `.meta` 一并删除。
pub fn delete_asset(root: &Path, rel: &str) -> Result<(), String> {
    if rel.is_empty() {
        return Err("资产路径为空".to_string());
    }
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {}", e))?;
    let target = resolve_in_root(&root_abs, rel)?;
    if !target.exists() {
        return Err(format!("资产不存在: {}", rel));
    }
    if target == root_abs {
        return Err("不能删除项目根目录".to_string());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("删除目录失败: {}", e))?;
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    let meta = sibling_with_meta(&target);
    if meta.is_file() {
        let _ = fs::remove_file(meta);
    }
    Ok(())
}

/// 重命名资产（文件或目录），新名只允许文件名（不含路径分隔符）。返回新相对路径。
pub fn rename_asset(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err("新名称为空".to_string());
    }
    if new_name.contains('/')
        || new_name.contains('\\')
        || new_name.contains(':')
        || new_name.contains("..")
    {
        return Err(format!("非法资产名: '{}'", new_name));
    }
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {}", e))?;
    let target = resolve_in_root(&root_abs, rel)?;
    if !target.exists() {
        return Err(format!("资产不存在: {}", rel));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "不能重命名项目根目录".to_string())?;
    let dest = parent.join(new_name);
    if dest == target {
        return Ok(rel.to_string());
    }
    let same_file = dest.canonicalize().map(|dc| dc == target).unwrap_or(false);
    if dest.exists() && !same_file {
        return Err(format!("名称已存在: {}", new_name));
    }
    if same_file {
        let tmp = parent.join(format!(".thr-tmp-{}", uuid::Uuid::new_v4()));
        fs::rename(&target, &tmp).map_err(|e| format!("重命名失败: {}", e))?;
        fs::rename(&tmp, &dest).map_err(|e| format!("重命名失败: {}", e))?;
    } else {
        fs::rename(&target, &dest).map_err(|e| format!("重命名失败: {}", e))?;
    }
    let meta_src = sibling_with_meta(&target);
    if meta_src.is_file() {
        let meta_dest = sibling_with_meta(&dest);
        let meta_same = meta_dest.canonicalize().ok() == meta_src.canonicalize().ok();
        if meta_same {
            let tmp = parent.join(format!(".thr-tmp-{}", uuid::Uuid::new_v4()));
            fs::rename(&meta_src, &tmp).map_err(|e| format!("重命名 meta 失败: {}", e))?;
            fs::rename(&tmp, &meta_dest).map_err(|e| format!("重命名 meta 失败: {}", e))?;
        } else {
            if meta_dest.exists() {
                let _ = fs::remove_file(&meta_dest);
            }
            fs::rename(&meta_src, &meta_dest).map_err(|e| format!("重命名 meta 失败: {}", e))?;
        }
    }
    ensure_meta(&dest)?;
    let new_rel = dest
        .strip_prefix(&root_abs)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(new_rel)
}

/// 在项目内新建目录（rel 为完整相对路径）。
pub fn create_folder(root: &Path, rel: &str) -> Result<String, String> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("目录路径为空".to_string());
    }
    let segs: Vec<&str> = rel.split('/').collect();
    if segs
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains('\\') || s.contains(':'))
    {
        return Err(format!("非法目录路径: '{}'", rel));
    }
    let root_abs = root
        .canonicalize()
        .map_err(|e| format!("无法解析项目目录: {}", e))?;
    let dest = resolve_in_root(&root_abs, rel)?;
    if dest.exists() {
        return Err(format!("已存在: {}", rel));
    }
    fs::create_dir_all(&dest).map_err(|e| format!("创建目录失败: {}", e))?;
    ensure_meta(&dest)?;
    Ok(rel.replace('\\', "/"))
}