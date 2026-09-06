// 构建期：把编辑器内置资源（public/internal/…）打包进二进制，
// 运行时由 exe 启动时提取到其同级 public/internal（免安装便携），
// 开发（debug）则直接读取仓库 public/internal。
// 归档格式：u32 条数 + 每条 [u32 pathLen][path][u32 dataLen][data]，
// 其中 path 以 "internal/" 为前缀（如 "internal/materials/Default.mat"）。

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

fn collect_files(dir: &Path, base: &Path, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                collect_files(&p, base, prefix, out);
            } else if let Ok(rel) = p.strip_prefix(base) {
                if let Ok(bytes) = std::fs::read(&p) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    out.push((format!("{prefix}/{rel_str}"), bytes));
                }
            }
        }
    }
}

fn main() {
    tauri_build::build();

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out_dir = std::env::var("OUT_DIR").unwrap();

    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for kind in ["internal"] {
        let dir = PathBuf::from(&manifest_dir).join("../public").join(kind);
        println!("cargo:rerun-if-changed={}", dir.display());
        collect_files(&dir, &dir, kind, &mut entries);
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut raw: Vec<u8> = Vec::new();
    raw.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (path, data) in &entries {
        raw.extend_from_slice(&(path.len() as u32).to_le_bytes());
        raw.extend_from_slice(path.as_bytes());
        raw.extend_from_slice(&(data.len() as u32).to_le_bytes());
        raw.extend_from_slice(data);
    }

    let out_path = Path::new(&out_dir).join("internal.bin");
    let mut f = File::create(&out_path).expect("create internal.bin");
    f.write_all(&raw).expect("write internal.bin");
}
