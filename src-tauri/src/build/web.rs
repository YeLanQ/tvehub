//! web 渠道产物管线：场景资产收集（复用 preview::collect_scene_assets）→
//! 发布模式处理 → gzip/形态分流组装 → 写盘 → 自描述结果。

use std::collections::HashMap;
use std::fs;

use super::classify::{is_minifiable_script, is_runtime_code, scene_entry_name};
use super::config::product_config;
use super::job::{BuildResult, JobCtx, PackedScene, Prepared};
use super::multi_file::assemble_multi_file;
use super::release::{apply_release, minify_js_source};
use super::single_page::assemble_single_page;
use super::urls::THREE_RUNTIME_FILES;
use super::ChannelPipeline;

/// web 渠道：打包静态网页产物（多文件 / 单页 × gzip 可选 × 发布模式可选）
pub struct WebPipeline;

impl ChannelPipeline for WebPipeline {
    fn build(&self, p: &Prepared, ctx: &JobCtx) -> Result<BuildResult, String> {
        let job = &p.job;
        let mut files = job.files.clone();
        // CDN 模式：three.js 运行时不内嵌，代码里指向 three 的相对 import 在
        // 产物组装阶段统一重写为 CDN 绝对 URL；其余 engine/ 模块仍内嵌
        if p.cdn_active {
            for rel in THREE_RUNTIME_FILES {
                files.remove(rel);
            }
        }
        let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();

        // 逐场景：并行读盘 + 收集引用资产 → 合并去重（跨场景共用同一资产只读一次）
        let mut packed: Vec<PackedScene> = Vec::new();
        let mut used_names: Vec<String> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let mut scene_texts: Vec<(String, String)> = Vec::new();

        use rayon::prelude::*;
        let scene_results: Vec<(
            String,
            String,
            HashMap<String, String>,
            HashMap<String, Vec<u8>>,
            Vec<String>,
        )> = job
            .scenes
            .par_iter()
            .map(|rel| {
                let text = crate::project::resolve_in_root(&p.root_path, rel)
                    .and_then(|path| fs::read_to_string(&path).map_err(|e| e.to_string()))
                    .map_err(|e| format!("读取场景失败 '{rel}': {e}"))?;
                let mut sf: HashMap<String, String> = HashMap::new();
                let mut sb: HashMap<String, Vec<u8>> = HashMap::new();
                let sm = crate::preview::collect_scene_assets(&p.root_path, &text, &mut sf, &mut sb);
                Ok::<_, String>((rel.clone(), text, sf, sb, sm))
            })
            .collect::<Result<Vec<_>, String>>()?;

        // 合并各场景独立收集结果到全局 map（去重：已存在不覆盖，保留首次读入）
        for (_, _, sf, sb, sm) in &scene_results {
            for (k, v) in sf {
                files.entry(k.clone()).or_insert_with(|| v.clone());
            }
            for (k, v) in sb {
                binaries.entry(k.clone()).or_insert_with(|| v.clone());
            }
            missing.extend(sm.iter().cloned());
        }
        // 场景名去重需串行累积 used_names
        for (rel, text, _, _, _) in scene_results {
            let name = scene_entry_name(&rel, &mut used_names);
            scene_texts.push((format!("scenes/{name}.json"), text));
            packed.push(PackedScene {
                name,
                rel,
                file: String::new(),
            });
        }
        for (i, (file, _)) in scene_texts.iter().enumerate() {
            packed[i].file = file.clone();
        }

        if ctx.cancelled() {
            return Err("任务已取消".into());
        }
        ctx.progress(0.3, "场景资产收集完成");

        // 发布模式：模型二进制化（LQENBIN1）+ 资源 uid 重命名 + 场景/材质引用重写 + JSON 压缩
        let mut bin_converted: Vec<String> = Vec::new();
        if job.release {
            apply_release(
                &p.root_path,
                &mut files,
                &mut binaries,
                &mut scene_texts,
                &mut bin_converted,
            );
        }

        // config = 项目配置（设计分辨率/缩放模式/渲染合成等，player 舞台直接消费）
        // + 构建入口信息（mainScene/scenes/debug）
        let project_cfg: serde_json::Value =
            fs::read_to_string(p.root_path.join("project.config.json"))
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(serde_json::Value::Null);
        let main_name = packed
            .iter()
            .find(|s| s.rel == p.main_scene)
            .map(|s| s.name.clone())
            .unwrap_or_default();
        let cfg = product_config(project_cfg, &packed, &main_name, job.debug, &files, &p.gzip_base);

        // 归档/内联条目：场景 JSON + 材质等文本（files 里非运行时代码的部分）+ 资产二进制
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        if job.single_page || job.gzip {
            for (rel, text) in scene_texts {
                entries.push((rel, text.into_bytes()));
            }
            let mut code_files: HashMap<String, String> = HashMap::new();
            for (rel, text) in files.drain() {
                if is_runtime_code(&rel) {
                    code_files.insert(rel, text);
                } else {
                    entries.push((rel, text.into_bytes()));
                }
            }
            files = code_files;
            for (rel, bytes) in binaries.drain() {
                entries.push((rel, bytes));
            }
            entries.sort_by(|a, b| a.0.cmp(&b.0));
        } else {
            // 多文件非 gzip：场景/材质/资产按相对路径落盘
            for (rel, text) in scene_texts {
                files.insert(rel, text);
            }
        }

        // 发布模式：压缩运行时脚本（player / engine 模块 / 加载器；已压缩的 *.min.* 跳过）
        // CPU 密集，用 rayon 并行压缩各文件
        if job.release {
            use rayon::prelude::*;
            files.par_iter_mut().for_each(|(rel, text)| {
                if is_minifiable_script(rel) {
                    *text = minify_js_source(text);
                }
            });
        }

        ctx.progress(0.6, "产物组装中");
        // 产物组装：单页内联 / 多文件落盘
        let mut code_n = 0usize;
        if job.single_page {
            // 单页：运行时代码（player.mjs + engine/**）全部内联进入口页，产物仅剩 HTML
            code_n = assemble_single_page(
                &mut files,
                &mut entries,
                cfg,
                &p.three_base,
                p.cdn_active,
                job.gzip,
            )?;
        } else {
            assemble_multi_file(
                &mut files,
                &mut binaries,
                &entries,
                cfg,
                &p.three_base,
                p.cdn_active,
                job.gzip,
            )?;
        }

        ctx.progress(0.9, "写入产物");
        // 清空重建输出目录并写入全部产物
        crate::preview::write_export_dir(&p.out, files, &binaries)
            .map_err(|e| format!("写入构建产物失败: {e}"))?;

        let assets_packed = if job.single_page || job.gzip {
            // 单页 + gzip 时归档里含运行时代码条目，不计入资产数
            entries.len() - if job.single_page && job.gzip { code_n } else { 0 }
        } else {
            binaries.len() + packed.len()
        };
        let missing_n = missing.len();
        let bin_n = bin_converted.len();
        let mut message = String::from("构建完成");
        if bin_n > 0 {
            message.push_str(&format!("，模型→.bin {bin_n} 个"));
        }
        if missing_n > 0 {
            message.push_str(&format!("（{} 项缺失资产被跳过）", missing_n));
        }
        Ok(BuildResult {
            ok: true,
            channel: job.channel.clone(),
            output_dir: p.out.display().to_string(),
            main_scene: p.main_scene.clone(),
            main_scene_name: main_name,
            scenes: packed,
            single_page: job.single_page,
            gzip: job.gzip,
            release: job.release,
            cdn: p.cdn_active,
            bin_converted,
            assets_packed,
            missing: missing.clone(),
            message,
        })
    }
}
