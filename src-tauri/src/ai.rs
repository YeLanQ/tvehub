// ---------------------------------------------------------------------------
// 助手 LLM 外呼（OpenAI 兼容 /chat/completions）：
// - ai_chat_stream：流式对话（stream: true）。Rust 侧持连接解析 SSE，每个增量
//   分块经 `ai:chunk` 事件推给前端（复用任务进度的事件通道模式），结束发
//   `ai:done`、失败发 `ai:error`。命令本身立即返回，结果全走事件。
// - ai_cancel：按 reqId 置取消标记，流式循环在每个分块边界检查并提前收尾。
// - ai_list_models：GET {base}/models 拉模型清单（部分供应商不支持时前端手填兜底）。
// API Key 仅在 invoke 参数中传递、只用于本请求，不落数据库/日志。
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

/// 助手运行态：reqId -> 取消标记（流式循环按分块检查）
#[derive(Default)]
pub struct AiState {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatArgs {
    req_id: String,
    base_url: String,
    api_key: String,
    model: String,
    /// OpenAI messages 数组（含 system/user/assistant/tool）
    messages: serde_json::Value,
    temperature: Option<f64>,
    /// 思考模式：缺省/default = 不传参；on = 显式开启；off = 显式关闭
    thinking: Option<String>,
    /// 思考强度：low / medium / high（thinking = on 时随请求下发）
    thinking_effort: Option<String>,
}

/// 去除尾斜杠的 base 归一（"https://host/v1/" 与 "https://host/v1" 等价）
fn normalize_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// 启动一次流式对话：立即返回，增量/结束/错误经事件回推前端。
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AiState>,
    args: AiChatArgs,
) -> Result<(), String> {
    if args.base_url.trim().is_empty() || args.model.trim().is_empty() {
        return Err("缺少供应商地址或模型".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancels
        .lock()
        .map_err(|e| e.to_string())?
        .insert(args.req_id.clone(), cancel.clone());
    let req_id = args.req_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_stream(&app, &args, &cancel).await;
        if let Err(e) = result {
            let _ = app.emit("ai:error", json!({ "reqId": req_id, "message": e }));
        }
        if let Some(st) = app.try_state::<AiState>() {
            if let Ok(mut guard) = st.cancels.lock() {
                guard.remove(&args.req_id);
            }
        }
    });
    Ok(())
}

/// 组装 /chat/completions 请求体（含思考参数方言；纯函数便于单测）。
/// 思考方言按主流 OpenAI 兼容端点并发三套：
/// - thinking.type：GLM/Zhipu 系（enabled / disabled）
/// - enable_thinking：Qwen/DashScope/SiliconFlow 系（true / false）
/// - reasoning_effort：OpenAI o系/GPT-5、vLLM、Gemini 兼容层（low/medium/high/xhigh）
/// 不支持额外字段的严格端点会 400——前端以「默认（不传参）」兜底。
fn build_chat_body(args: &AiChatArgs) -> serde_json::Value {
    let mut body = json!({
        "model": args.model,
        "messages": args.messages,
        "stream": true,
    });
    if let Some(t) = args.temperature {
        body["temperature"] = json!(t);
    }
    match args.thinking.as_deref() {
        Some("on") => {
            body["thinking"] = json!({ "type": "enabled" });
            body["enable_thinking"] = json!(true);
            // 档位白名单 = 前端强度下拉的四档；各家模型档位不齐（低/中/高、
            // 低/高、低/高/最高），不支持的档位由用户换档，不在后端猜测夹值
            let effort = args.thinking_effort.as_deref().unwrap_or("medium");
            if matches!(effort, "low" | "medium" | "high" | "xhigh") {
                body["reasoning_effort"] = json!(effort);
            }
        }
        Some("off") => {
            body["thinking"] = json!({ "type": "disabled" });
            body["enable_thinking"] = json!(false);
        }
        _ => {} // 缺省/未知值：不改请求体，跟随供应商与模型默认
    }
    body
}

async fn run_stream(
    app: &AppHandle,
    args: &AiChatArgs,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", normalize_base(&args.base_url));
    let body = build_chat_body(args);
    let resp = reqwest::Client::new()
        .post(url)
        .json(&body)
        .timeout(Duration::from_secs(300));
    // 空 Key 不带 Authorization（本地端点如 Ollama/LM Studio 会拒绝空 Bearer）
    let resp = if args.api_key.trim().is_empty() {
        resp.send().await
    } else {
        resp.bearer_auth(&args.api_key).send().await
    }
    .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let short: String = text.chars().take(300).collect();
        return Err(format!("HTTP {status}: {short}"));
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit("ai:done", json!({ "reqId": args.req_id, "cancelled": true }));
            return Ok(());
        }
        buf.extend_from_slice(&chunk.map_err(|e| format!("读取流失败: {e}"))?);
        // 按行切分 SSE 帧；data: 前缀行才是载荷，其余（注释/空行）忽略
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let Some(data) = line.trim().strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data == "[DONE]" {
                let _ = app.emit("ai:done", json!({ "reqId": args.req_id }));
                return Ok(());
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            let Some(delta) = v["choices"][0].get("delta") else {
                continue;
            };
            // content 兼容两种形态：字符串（标准）与分段数组（部分网关发
            // [{type:"text","text":"…"}]）——只认字符串会整段丢正文，
            // 模型表现为"空回复"
            match delta.get("content") {
                Some(serde_json::Value::String(s)) => {
                    if !s.is_empty() {
                        let _ =
                            app.emit("ai:chunk", json!({ "reqId": args.req_id, "delta": s }));
                    }
                }
                Some(serde_json::Value::Array(parts)) => {
                    for part in parts {
                        if let Some(s) = part.get("text").and_then(|t| t.as_str()) {
                            if !s.is_empty() {
                                let _ = app.emit(
                                    "ai:chunk",
                                    json!({ "reqId": args.req_id, "delta": s }),
                                );
                            }
                        }
                    }
                }
                _ => {}
            }
            // 思考增量（ reasoning_content：DeepSeek/GLM/Qwen 系；reasoning：
            // OpenRouter 系）——单独字段下发，前端以 `ai:chunk` 的 reasoning
            // 通道聚合；不发思考的模型没有该键，零开销
            for key in ["reasoning_content", "reasoning"] {
                if let Some(s) = delta.get(key).and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        let _ = app.emit(
                            "ai:chunk",
                            json!({ "reqId": args.req_id, "reasoning": s }),
                        );
                    }
                }
            }
            // 工具调用增量（name/arguments 可能分多帧到达，前端按 index 聚合）
            if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                if !tcs.is_empty() {
                    let _ = app.emit(
                        "ai:chunk",
                        json!({ "reqId": args.req_id, "toolCalls": tcs }),
                    );
                }
            }
        }
    }
    // 服务端未发 [DONE] 就关流：按正常结束处理
    let _ = app.emit("ai:done", json!({ "reqId": args.req_id }));
    Ok(())
}

/// 取消进行中的流式对话（幂等；未知 reqId 静默忽略）
#[tauri::command]
pub async fn ai_cancel(state: State<'_, AiState>, req_id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().map_err(|e| e.to_string())?.get(&req_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 拉取模型清单（GET /models；部分供应商不支持 → 前端手填兜底）
#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let url = format!("{}/models", normalize_base(&base_url));
    let mut req = reqwest::Client::new().get(url.clone()).timeout(Duration::from_secs(20));
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(&api_key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 {url} 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("拉取 {url} 返回 HTTP {}", resp.status()));
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(thinking: Option<&str>, effort: Option<&str>) -> AiChatArgs {
        AiChatArgs {
            req_id: "r_test".into(),
            base_url: "https://x/v1".into(),
            api_key: String::new(),
            model: "m".into(),
            messages: json!([]),
            temperature: None,
            thinking: thinking.map(String::from),
            thinking_effort: effort.map(String::from),
        }
    }

    #[test]
    fn body_default_sends_no_thinking_keys() {
        let body = build_chat_body(&args(None, None));
        assert!(body.get("thinking").is_none());
        assert!(body.get("enable_thinking").is_none());
        assert!(body.get("reasoning_effort").is_none());
        assert_eq!(body["stream"], json!(true));
    }

    #[test]
    fn body_on_enables_all_dialects_with_effort() {
        let body = build_chat_body(&args(Some("on"), Some("high")));
        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert_eq!(body["enable_thinking"], json!(true));
        assert_eq!(body["reasoning_effort"], json!("high"));
    }

    #[test]
    fn body_on_without_effort_falls_back_medium() {
        let body = build_chat_body(&args(Some("on"), None));
        assert_eq!(body["reasoning_effort"], json!("medium"));
    }

    #[test]
    fn body_on_xhigh_passes_through() {
        let body = build_chat_body(&args(Some("on"), Some("xhigh")));
        assert_eq!(body["reasoning_effort"], json!("xhigh"));
    }

    #[test]
    fn body_off_disables_without_effort() {
        let body = build_chat_body(&args(Some("off"), Some("low")));
        assert_eq!(body["thinking"], json!({ "type": "disabled" }));
        assert_eq!(body["enable_thinking"], json!(false));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn body_unknown_thinking_value_is_ignored() {
        let body = build_chat_body(&args(Some("bogus"), None));
        assert!(body.get("thinking").is_none());
        assert!(body.get("enable_thinking").is_none());
    }

    #[test]
    fn body_invalid_effort_is_dropped() {
        let body = build_chat_body(&args(Some("on"), Some("max")));
        assert!(body.get("reasoning_effort").is_none());
    }
}
