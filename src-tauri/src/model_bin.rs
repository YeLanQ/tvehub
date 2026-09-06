//! 发布模式模型二进制化（移植 LQEN pack 方案：LQENBIN1 容器）：
//! - `.glb` → kind=1 包装（原始 GLB 字节，内嵌材质保留——本运行时模型网格始终使用
//!   GLB 内嵌材质，剥离会破坏外观，故不做 LQEN 的惰性剥离）；
//! - `.obj` → kind=0 顶点网格二进制（v/vt/vn/f → 小端数组，player 侧重建 BufferGeometry）；
//! - `.gltf`（JSON + 外部 .bin/贴图）→ 先内联 buffers/images 为自包含 GLB，再 kind=1 包装
//!   （LQEN 未处理 .gltf——其外部兄弟文件在 uid 重命名后会断链，此处一并解决）；
//! - 产物统一重命名为 `<uid>.bin`，player 按扩展名解包（见 libs/model.mjs parseBinModel）。
//! 转换失败回退原格式（保持 uid 重命名，不影响构建）。

use std::collections::HashMap;

/// 容器魔数（8 字节）+ u32 kind（LE）+ u32 payload 长度（LE）+ payload
const MAGIC: &[u8; 8] = b"LQENBIN1";

/// 极简 OBJ → 二进制（kind=0 顶点网格）：v/vt/vn/f → 小端二进制（LQEN 同款格式）
pub fn obj_to_bin(text: &str) -> Option<Vec<u8>> {
    let mut verts: Vec<[f32; 3]> = Vec::new();
    let mut norms: Vec<[f32; 3]> = Vec::new();
    let mut uvs: Vec<[f32; 2]> = Vec::new();
    let mut faces: Vec<[u32; 3]> = Vec::new();
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(kind) = it.next() else { continue };
        match kind {
            "v" => {
                let mut a = [0f32; 3];
                for c in a.iter_mut() {
                    *c = it.next()?.parse().ok()?;
                }
                verts.push(a);
            }
            "vn" => {
                let mut a = [0f32; 3];
                for c in a.iter_mut() {
                    *c = it.next()?.parse().ok()?;
                }
                norms.push(a);
            }
            "vt" => {
                let mut a = [0f32; 2];
                for c in a.iter_mut() {
                    *c = it.next()?.parse().ok()?;
                }
                uvs.push(a);
            }
            "f" => {
                let mut idxs = [0u32; 3];
                for i in 0..3 {
                    let tok = it.next()?;
                    let first = tok.split('/').next()?.parse::<u32>().ok()?;
                    idxs[i] = if first > 0 { first - 1 } else { 0 };
                }
                faces.push(idxs);
            }
            _ => {}
        }
    }
    if verts.is_empty() || faces.is_empty() {
        return None;
    }
    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&0u32.to_le_bytes()); // kind: 0 = 顶点网格
    for n in [
        verts.len() as u32,
        norms.len() as u32,
        uvs.len() as u32,
        faces.len() as u32,
    ] {
        out.extend_from_slice(&n.to_le_bytes());
    }
    for a in &verts {
        for c in a {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    for a in &norms {
        for c in a {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    for a in &uvs {
        for c in a {
            out.extend_from_slice(&c.to_le_bytes());
        }
    }
    for f in &faces {
        for i in f {
            out.extend_from_slice(&i.to_le_bytes());
        }
    }
    Some(out)
}

/// GLB → kind=1 包装（原始 GLB 字节，内嵌材质/动画全保留）
pub fn glb_to_bin(bytes: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(16 + bytes.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&1u32.to_le_bytes()); // kind: 1 = glb 原始字节
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
    out
}

/// 数据 URI / 文件兄弟引用 → 字节（文件引用记录进 inlined，调用方决定是否从产物剔除）
fn resolve_uri(
    model_rel: &str,
    uri: &str,
    binaries: &HashMap<String, Vec<u8>>,
    inlined: &mut Vec<String>,
) -> Option<Vec<u8>> {
    if let Some(b64) = uri
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(','))
        .map(|(_, b64)| b64)
    {
        use base64::Engine as _;
        let cleaned: String = b64.chars().filter(|c| !c.is_whitespace()).collect();
        return base64::engine::general_purpose::STANDARD.decode(cleaned).ok();
    }
    let sib = crate::preview::gltf_sibling_rel(model_rel, uri)?;
    let data = binaries.get(&sib)?;
    inlined.push(sib);
    Some(data.clone())
}

fn mime_of(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// .gltf（JSON + 外部 .bin/贴图）→ 自包含 GLB：buffers 合并内联、images 转 bufferView、
/// JSON 紧凑化。外部兄弟文件记入 inlined（打包时剔除）。解析失败/外部数据缺失 → None。
fn gltf_to_glb(
    rel: &str,
    bytes: &[u8],
    binaries: &HashMap<String, Vec<u8>>,
) -> Option<(Vec<u8>, Vec<String>)> {
    let mut json: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let mut inlined: Vec<String> = Vec::new();
    let mut blob: Vec<u8> = Vec::new();

    // buffers：全部数据按顺序合并（每个 4 字节对齐），记录各 buffer 的起始前缀
    let mut prefixes: Vec<usize> = Vec::new();
    let bufs = json
        .get_mut("buffers")
        .and_then(|v| v.as_array_mut())
        .map(std::mem::take)
        .unwrap_or_default();
    for b in &bufs {
        prefixes.push(blob.len());
        if let Some(uri) = b.get("uri").and_then(|v| v.as_str()) {
            let data = resolve_uri(rel, uri, binaries, &mut inlined)?;
            blob.extend_from_slice(&data);
            while blob.len() % 4 != 0 {
                blob.push(0);
            }
        }
    }

    // bufferViews：buffer 索引归零，字节偏移加上所属 buffer 的合并前缀
    if let Some(bvs) = json.get_mut("bufferViews").and_then(|v| v.as_array_mut()) {
        for bv in bvs.iter_mut() {
            let bi = bv.get("buffer").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let off = bv.get("byteOffset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            if let Some(o) = bv.as_object_mut() {
                o.insert("buffer".into(), serde_json::json!(0));
                o.insert(
                    "byteOffset".into(),
                    serde_json::json!(prefixes.get(bi).copied().unwrap_or(0) + off),
                );
            }
        }
    }

    // images：文件/数据 URI → bufferView 内联（附加到 blob 尾部，4 字节对齐）
    let mut bvs = match json.get_mut("bufferViews") {
        Some(v) => v.as_array_mut().map(std::mem::take).unwrap_or_default(),
        None => Vec::new(),
    };
    let had_images = json
        .get("images")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    let mut imgs = json
        .get_mut("images")
        .and_then(|v| v.as_array_mut())
        .map(std::mem::take)
        .unwrap_or_default();
    for img in imgs.iter_mut() {
        let Some(uri) = img.get("uri").and_then(|v| v.as_str()).map(String::from) else {
            continue; // 已是 bufferView 引用
        };
        let data = resolve_uri(rel, &uri, binaries, &mut inlined)?;
        let ext = uri.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let mime = mime_of(&ext)?;
        while blob.len() % 4 != 0 {
            blob.push(0);
        }
        let bv = serde_json::json!({
            "buffer": 0,
            "byteOffset": blob.len(),
            "byteLength": data.len(),
        });
        let bv_index = bvs.len();
        bvs.push(bv);
        blob.extend_from_slice(&data);
        if let Some(o) = img.as_object_mut() {
            o.remove("uri");
            o.insert("bufferView".into(), serde_json::json!(bv_index));
            o.insert("mimeType".into(), serde_json::json!(mime));
        }
    }
    if had_images {
        json.as_object_mut()?
            .insert("images".into(), serde_json::Value::Array(imgs));
    }
    json.as_object_mut()?
        .insert("bufferViews".into(), serde_json::Value::Array(bvs));

    // buffers 收敛为单个内嵌 buffer
    if let Some(o) = json.as_object_mut() {
        o.insert("buffers".into(), serde_json::json!([{ "byteLength": blob.len() }]));
    }

    Some((build_glb_container(&json, &blob), inlined))
}

/// 打包 GLB 容器：头 + JSON chunk（空格填充）+ BIN chunk（零填充）
fn build_glb_container(json: &serde_json::Value, bin: &[u8]) -> Vec<u8> {
    let mut json_bytes = json.to_string().into_bytes();
    let jpad = (4 - json_bytes.len() % 4) % 4;
    json_bytes.resize(json_bytes.len() + jpad, 0x20);
    let bpad = (4 - bin.len() % 4) % 4;
    let total = 12 + 8 + json_bytes.len() + if bin.is_empty() { 0 } else { 8 + bin.len() + bpad };
    let mut out: Vec<u8> = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&0x4E4F_534Au32.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    if !bin.is_empty() {
        out.extend_from_slice(&((bin.len() + bpad) as u32).to_le_bytes());
        out.extend_from_slice(&0x004E_4942u32.to_le_bytes());
        out.extend_from_slice(bin);
        out.resize(total, 0);
    }
    out
}

/// 模型转换分派（发布模式）：glb/gltf → kind=1，obj → kind=0。
/// 返回（LQENBIN1 字节, 被内联而不再打包的外部兄弟文件）；失败 → None（回退原格式）。
pub(crate) fn convert_model_to_bin(
    rel: &str,
    binaries: &HashMap<String, Vec<u8>>,
) -> Option<(Vec<u8>, Vec<String>)> {
    let ext = rel.rsplit('.').next()?.to_ascii_lowercase();
    let bytes = binaries.get(rel)?;
    match ext.as_str() {
        "glb" => Some((glb_to_bin(bytes), Vec::new())),
        "obj" => {
            let text = String::from_utf8_lossy(bytes);
            obj_to_bin(&text).map(|b| (b, Vec::new()))
        }
        "gltf" => {
            let (glb, inlined) = gltf_to_glb(rel, bytes, binaries)?;
            Some((glb_to_bin(&glb), inlined))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_glb_container, glb_to_bin, obj_to_bin};

    #[test]
    fn obj_bin_layout() {
        let obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvn 0 0 1\nf 1/1/1 2/2/2 3/3/3\n";
        let bin = obj_to_bin(obj).unwrap();
        assert_eq!(&bin[0..8], b"LQENBIN1");
        assert_eq!(u32::from_le_bytes(bin[8..12].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(bin[12..16].try_into().unwrap()), 3); // verts
        assert_eq!(u32::from_le_bytes(bin[16..20].try_into().unwrap()), 1); // norms
        assert_eq!(u32::from_le_bytes(bin[20..24].try_into().unwrap()), 1); // uvs
        assert_eq!(u32::from_le_bytes(bin[24..28].try_into().unwrap()), 1); // faces
        // 顶点数据从 28 开始：第一个顶点 x=0
        assert_eq!(f32::from_le_bytes(bin[28..32].try_into().unwrap()), 0.0);
        // obj 无效（无面）→ None
        assert!(obj_to_bin("v 0 0 0\n").is_none());
    }

    #[test]
    fn glb_bin_wraps_raw() {
        let glb = b"glTF-fake-bytes";
        let bin = glb_to_bin(glb);
        assert_eq!(&bin[0..8], b"LQENBIN1");
        assert_eq!(u32::from_le_bytes(bin[8..12].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(bin[12..16].try_into().unwrap()), 15);
        assert_eq!(&bin[16..], glb);
    }

    #[test]
    fn glb_container_layout() {
        let json = serde_json::json!({ "asset": { "version": "2.0" } });
        let glb = build_glb_container(&json, &[1, 2, 3]);
        assert_eq!(&glb[0..4], b"glTF");
        // 头 12 字节 + JSON chunk 头 8 字节(len,type) → 类型在 [16..20]
        let jlen = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
        assert_eq!(&glb[16..20], &[0x4A, 0x53, 0x4F, 0x4E]); // JSON chunk（类型 0x4E4F534A LE）
        let bin_off = 12 + 8 + jlen;
        assert_eq!(&glb[bin_off..bin_off + 4], &[4, 0, 0, 0]); // BIN chunk len（含填充）
        assert_eq!(&glb[bin_off + 4..bin_off + 8], &[0x42, 0x49, 0x4E, 0x00]); // BIN chunk
        assert_eq!(u32::from_le_bytes(glb[8..12].try_into().unwrap()) as usize, glb.len());
    }
}
