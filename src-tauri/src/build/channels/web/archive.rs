//! gzip 归档与单页内联数据脚本：归档帧格式（u32 条数 + 定长头条目）整体 gzip；
//! 单页把 config/资产/运行时代码序列化进 index.html 的 window.__TVE_BUILD_DATA。

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::io::Write;

/// 归档帧格式：u32 条数(LE) + 每条 [u32 pathLen][path][u32 dataLen][data]，整体 gzip
pub(super) fn build_archive_bytes(entries: &[(String, Vec<u8>)]) -> Result<Vec<u8>, String> {
    let mut raw = Vec::new();
    raw.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    for (path, data) in entries {
        raw.extend_from_slice(&(path.len() as u32).to_le_bytes());
        raw.extend_from_slice(path.as_bytes());
        raw.extend_from_slice(&(data.len() as u32).to_le_bytes());
        raw.extend_from_slice(data);
    }
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(&raw).map_err(|e| format!("gzip 压缩失败: {e}"))?;
    enc.finish().map_err(|e| format!("gzip 压缩失败: {e}"))
}

/// 单页模式的内联数据脚本：注入 index.html，运行时经 window.__TVE_BUILD_DATA 读取。
/// 非 gzip 时 code 为运行时代码文本表（player.mjs + engine/**，已重写说明符），
/// gzip 时代码并入 entries 归档。序列化后把 '<' 转义为 \u003c，
/// 防止代码文本里的 `</script>` 提前终止内联脚本标签（\u 转义解码后语义不变）
pub(super) fn inline_data_script(
    config: serde_json::Map<String, serde_json::Value>,
    entries: &[(String, Vec<u8>)],
    gzip: bool,
    code: Option<&HashMap<String, String>>,
) -> Result<String, String> {
    let mut data = serde_json::Map::new();
    data.insert("config".to_string(), serde_json::Value::Object(config));
    if gzip {
        data.insert(
            "pak".to_string(),
            serde_json::Value::String(BASE64.encode(build_archive_bytes(entries)?)),
        );
    } else {
        let assets: serde_json::Map<String, serde_json::Value> = entries
            .iter()
            .map(|(rel, bytes)| (rel.clone(), serde_json::Value::String(BASE64.encode(bytes))))
            .collect();
        data.insert("assets".to_string(), serde_json::Value::Object(assets));
        if let Some(code) = code {
            let map: serde_json::Map<String, serde_json::Value> = code
                .iter()
                .map(|(rel, text)| (rel.clone(), serde_json::Value::String(text.clone())))
                .collect();
            data.insert("code".to_string(), serde_json::Value::Object(map));
        }
    }
    let json = serde_json::Value::Object(data).to_string().replace('<', "\\u003c");
    Ok(format!(
        "<script>window.__TVE_BUILD_DATA = {json};</script>"
    ))
}

#[cfg(test)]
mod tests {
    use super::build_archive_bytes;

    #[test]
    fn archive_is_gzip() {
        let entries = vec![
            ("scenes/a.json".to_string(), b"{\"root\":1}".to_vec()),
            ("assets/models/x.glb".to_string(), vec![1u8, 2, 3]),
        ];
        let pak = build_archive_bytes(&entries).unwrap();
        // gzip 魔数 1f 8b
        assert_eq!(&pak[..2], &[0x1f, 0x8b]);
    }
}

