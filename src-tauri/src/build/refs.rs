//! 发布模式引用重写：场景 JSON（材质/模型/贴图/逻辑资产引用）、.texcube 贴图、
//! .mat 材质字段与着色器 props 的旧路径 → uid 新路径改写。

use std::collections::HashMap;

/// 递归重写 JSON 里 meshNode 的 material/model、skyboxNode 的 cubeMap、组件 animationClip 的 clip、
/// 音源的 audio.source、粒子系统的 particles.texture、UI Widget（图片/按钮）的 image、
/// 逻辑运行器（fsmRunnerNode/btRunnerNode）settings.asset 的 .fsm/.bt 资产引用
pub(super) fn rewrite_scene_refs(v: &mut serde_json::Value, renames: &HashMap<String, String>) {
    match v {
        serde_json::Value::Array(items) => {
            for i in items {
                rewrite_scene_refs(i, renames);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if (k == "material" || k == "model" || k == "cubeMap" || k == "clip") && val.is_string() {
                    if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                        *val = serde_json::Value::String(new.clone());
                    }
                } else if k == "audio" {
                    // 音源节点：audio.source 为音频资产引用（其余播放参数不含路径）
                    if let Some(src) = val.get_mut("source") {
                        if src.is_string() {
                            if let Some(new) = renames.get(src.as_str().unwrap_or("")) {
                                *src = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                } else if k == "particles" {
                    // 粒子系统节点：particles.texture 为图片资产引用（其余发射参数不含路径）
                    if let Some(tex) = val.get_mut("texture") {
                        if tex.is_string() {
                            if let Some(new) = renames.get(tex.as_str().unwrap_or("")) {
                                *tex = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                } else if k == "image" && val.is_string() {
                    // UI Widget（uiImageNode/uiButtonNode）：image 为图片资产引用
                    if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                        *val = serde_json::Value::String(new.clone());
                    }
                } else if k == "materialSettings" {
                    // 地形节点：materialSettings.splatmap + layers[].albedoMap/normalMap
                    if let Some(ms) = val.as_object_mut() {
                        if let Some(new) = ms.get("splatmap").and_then(|v| v.as_str()).and_then(|s| renames.get(s)) {
                            *ms.get_mut("splatmap").unwrap() = serde_json::Value::String(new.clone());
                        }
                        if let Some(layers) = ms.get_mut("layers").and_then(|v| v.as_array_mut()) {
                            for l in layers.iter_mut() {
                                if let Some(lo) = l.as_object_mut() {
                                    for field in ["albedoMap", "normalMap"] {
                                        if let Some(new) = lo.get(field).and_then(|v| v.as_str()).and_then(|s| renames.get(s)) {
                                            *lo.get_mut(field).unwrap() = serde_json::Value::String(new.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if k == "settings" {
                    // 逻辑运行器节点（fsmRunnerNode/btRunnerNode）：settings.asset 为
                    // .fsm/.bt 逻辑资产引用（其余设置非路径；未改名值查表自然不命中）
                    if let Some(asset) = val.get_mut("asset") {
                        if asset.is_string() {
                            if let Some(new) = renames.get(asset.as_str().unwrap_or("")) {
                                *asset = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                } else {
                    rewrite_scene_refs(val, renames);
                }
            }
        }
        _ => {}
    }
}

/// 重写 .texcube JSON 里贴图引用（equirect 的 map / faces 各面）；parse 成功则同时紧凑化
pub(super) fn rewrite_texcube_text(text: &str, renames: &HashMap<String, String>) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    let Some(obj) = v.as_object_mut() else {
        return text.to_string();
    };
    let rewrite = |val: &mut serde_json::Value| {
        if val.is_string() {
            if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                *val = serde_json::Value::String(new.clone());
            }
        }
    };
    if let Some(map) = obj.get_mut("map") {
        rewrite(map);
    }
    if let Some(faces) = obj.get_mut("faces").and_then(|f| f.as_object_mut()) {
        for (_, val) in faces.iter_mut() {
            rewrite(val);
        }
    }
    v.to_string()
}

/// 重写 .mat JSON 里贴图字段引用；parse 成功则同时紧凑化（发布模式 JSON 压缩）。
/// cubeMap 为天空盒材质的 TextureCube 引用，shader 为材质挂的着色器资产引用，
/// props 内着色器 Properties 的贴图参数值（字符串）一并重写，三者随重命名表同步。
pub(super) fn rewrite_mat_text(text: &str, renames: &HashMap<String, String>) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    if let serde_json::Value::Object(map) = &mut v {
        for (k, val) in map.iter_mut() {
            if (crate::preview::TEXTURE_FIELDS.contains(&k.as_str()) || k == "cubeMap" || k == "shader")
                && val.is_string()
            {
                if let Some(new) = renames.get(val.as_str().unwrap_or("")) {
                    *val = serde_json::Value::String(new.clone());
                }
            }
            // 着色器参数：字符串值即贴图引用（颜色为数字、向量为数组，不受影响）
            if k == "props" {
                if let serde_json::Value::Object(props) = val {
                    for (_, pv) in props.iter_mut() {
                        if let Some(old) = pv.as_str() {
                            if let Some(new) = renames.get(old) {
                                *pv = serde_json::Value::String(new.clone());
                            }
                        }
                    }
                }
            }
        }
    }
    v.to_string()
}
