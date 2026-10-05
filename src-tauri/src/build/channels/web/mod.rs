//! web 渠道产物管线（工厂桥接的渠道实现之一）：场景资产收集（kernel）→
//! 发布模式压缩 → gzip/形态分流组装（单页 single_page / 多文件 multi_file
//! 子模块）→ 写盘 → 自描述结果。
//!
//! 渠道结构与微信渠道（../wechat/）对称：mod.rs 只做编排；archive（gzip 归档/
//! 单页内联数据）、specifiers（模块说明符重写）、urls（远程地址/Three CDN）
//! 为本渠道专属阶段。渠道选项语义（地址归一化、CDN 生效判定）在 resolve
//! 一次完成，编排体内只消费归一化后的 WebParams。

use std::collections::HashMap;

use crate::build::finalize::{
    finish_result, main_scene_name, read_project_config, write_products, ResultDraft,
};
use crate::build::job::{BuildJob, BuildResult, JobCtx, Prepared};
use crate::build::kernel::classify::{is_minifiable_script, is_runtime_code};
use crate::build::kernel::content::build_content;
use crate::build::kernel::release::minify_js_source;
use crate::build::options::{ResolvedChannel, WebParams};
use crate::build::pipeline::{progress, ChannelPipeline};
use crate::build::steps::config::product_config;

mod archive;
mod multi_file;
mod single_page;
mod specifiers;
mod urls;
use self::multi_file::assemble_multi_file;
use self::single_page::assemble_single_page;

/// web 渠道：打包静态网页产物（多文件 / 单页 × gzip 可选 × 发布模式可选）
pub struct WebPipeline;

impl ChannelPipeline for WebPipeline {
    fn id(&self) -> &'static str {
        "web"
    }

    fn resolve(&self, job: &BuildJob) -> ResolvedChannel {
        // 两个地址相互独立、各自归一化（去空白与结尾 '/'，无协议补 https://）：
        // - gzip_base：gzip 归档远程基址（非空时写入 config 供运行时远程拉取）；
        // - three_base：Three CDN 基址，仅在 CDN 模式开启时生效（three.js 不内嵌）；
        // 留空均回退当前行为（归档本地读取 / three 内嵌）。拼接相对路径时经
        // join_cdn_url 去重已带的前缀（如地址以 /engine、/assets.gzip 结尾不重复拼）
        let gzip_base = urls::normalize_base_url(&job.gzip_base);
        let three_base = urls::normalize_base_url(&job.cdn_base);
        ResolvedChannel::Web(WebParams {
            single_page: job.single_page,
            gzip: job.gzip,
            cdn_active: job.cdn && !three_base.is_empty(),
            gzip_base,
            three_base,
        })
    }

    fn preflight(&self, job: &BuildJob) -> Result<(), String> {
        // 入口页预检：网页运行时必须带 index.html（wechat 渠道入口是预构建
        // code.js，由该管线自行校验）
        if job.files.contains_key("index.html") {
            Ok(())
        } else {
            Err("网页运行时缺少 index.html".to_string())
        }
    }

    fn build(&self, p: &Prepared, ctx: &JobCtx) -> Result<BuildResult, String> {
        let web = p.channel.web();
        let job = &p.job;
        let mut files = job.files.clone();
        // 前端运行时清单里的 .wasm（base64 混在文本 map 里）分流进 binaries：
        // 文本 IPC 通道会 UTF-8 损坏二进制，按字节写盘/内联
        let mut binaries: HashMap<String, Vec<u8>> = HashMap::new();
        crate::scene_pack::split_wasm_base64_files(&mut files, &mut binaries)?;
        // CDN 模式：three.js 运行时不内嵌，代码里指向 three 的相对 import 在
        // 产物组装阶段统一重写为 CDN 绝对 URL；其余 engine/ 模块仍内嵌
        if web.cdn_active {
            for rel in urls::THREE_RUNTIME_FILES {
                files.remove(rel);
            }
        }

        // 导出内容内核：场景收集 + 引用资产合并去重 + release 处理（与 wechat
        // 渠道同源同构，跨渠道一致性由 tests/consistency_e2e.rs 守护）
        ctx.progress(progress::COLLECT, "收集场景与资产");
        let mut content = build_content(&p.root_path, &job.scenes, job.release)?;
        // web 渠道语义：文本资产并入运行时 files（与 player.mjs/engine 同一命名
        // 空间按相对路径落盘/归档）；二进制独立成 map 走归档或落盘
        for (k, v) in content.text_assets {
            files.entry(k).or_insert(v);
        }
        for (k, v) in content.binaries {
            binaries.entry(k).or_insert(v);
        }

        if ctx.cancelled() {
            return Err("任务已取消".into());
        }
        ctx.progress(progress::ASSEMBLE, "组装产物");

        // config = 项目配置（设计分辨率/缩放模式/渲染合成等，player 舞台直接消费）
        // + 构建入口信息（mainScene/scenes/debug）
        let project_cfg = read_project_config(&p.root_path);
        let main_name = main_scene_name(&content.packed, &p.main_scene);
        let cfg = product_config(project_cfg, &content.packed, &main_name, job.debug, &files, &web.gzip_base);

        // 归档/内联条目：场景 JSON + 材质等文本（files 里非运行时代码的部分）+ 资产二进制
        let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
        if web.single_page || web.gzip {
            for (rel, text) in content.scene_texts.drain(..) {
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
            // 单页：wasm 一并内联进资产表（物理回退主线程，fetch 垫片供数）；
            // 多文件 gzip：.wasm 保持真实文件落盘——gzip 归档里的条目只能被主线程
            // 的 fetch 垫片命中，物理 Worker / three 解码 Worker 的取数拿不到
            let mut archived = HashMap::new();
            for (rel, bytes) in binaries.drain() {
                if web.gzip && !web.single_page && rel.ends_with(".wasm") {
                    archived.insert(rel, bytes);
                } else {
                    entries.push((rel, bytes));
                }
            }
            binaries = archived;
            entries.sort_by(|a, b| a.0.cmp(&b.0));
        } else {
            // 多文件非 gzip：场景/材质/资产按相对路径落盘
            for (rel, text) in content.scene_texts {
                files.insert(rel, text);
            }
        }

        // 发布模式：压缩运行时脚本（player / engine 模块 / 加载器；已压缩的 *.min.* 跳过）
        // CPU 密集，用 rayon 并行压缩各文件
        if job.release {
            if ctx.cancelled() {
                return Err("任务已取消".into());
            }
            use rayon::prelude::*;
            files.par_iter_mut().for_each(|(rel, text)| {
                if is_minifiable_script(rel) {
                    *text = minify_js_source(text);
                }
            });
        }

        // 产物组装：单页内联 / 多文件落盘
        let mut code_n = 0usize;
        if web.single_page {
            // 单页：运行时代码（player.mjs + engine/**）全部内联进入口页，产物仅剩 HTML
            code_n = assemble_single_page(
                &mut files,
                &mut entries,
                cfg,
                &web.three_base,
                web.cdn_active,
                web.gzip,
            )?;
        } else {
            assemble_multi_file(
                &mut files,
                &mut binaries,
                &entries,
                cfg,
                &web.three_base,
                web.cdn_active,
                web.gzip,
            )?;
        }

        // 写盘（公共收尾：取消检查 + 写入锚点 + 原子换入）
        write_products(p, files, &binaries, ctx)?;

        let assets_packed = if web.single_page || web.gzip {
            // 单页 + gzip 时归档里含运行时代码条目，不计入资产数
            entries.len() - if web.single_page && web.gzip { code_n } else { 0 }
        } else {
            content.assets_packed
        };
        let missing_n = content.missing.len();
        let bin_n = content.bin_converted.len();
        let mut message = String::from("构建完成");
        if bin_n > 0 {
            message.push_str(&format!("，模型→.bin {bin_n} 个"));
        }
        if missing_n > 0 {
            message.push_str(&format!("（{} 项缺失资产被跳过）", missing_n));
        }
        Ok(finish_result(
            p,
            ResultDraft {
                packed: content.packed,
                main_name,
                bin_converted: content.bin_converted,
                assets_packed,
                missing: content.missing,
                single_page: web.single_page,
                gzip: web.gzip,
                cdn: web.cdn_active,
                message,
            },
        ))
    }
}
