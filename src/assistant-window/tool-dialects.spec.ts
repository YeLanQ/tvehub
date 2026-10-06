// 通用工具调用语法引擎回归：结构标记（DSML / invoke / 任意前缀装饰）按结构
// 解析而非按品牌堆正则——DeepSeek DSML 方言（string="false" 参数、同名对象壳、
// 零参 invoke、calls 包裹块）是当前主案例；非标记壳（python_tag/[TOOL_CALLS]）
// 与痕迹/净化出口一并覆盖。
import { describe, expect, it } from "vitest";
import { scanDialectCalls, scanTagCalls } from "./tool-dialects";
import { scanExoticShells } from "./tool-dialect-shells";
import { hasTagCallTrace, stripTagCalls } from "./tool-dialect-sanitize";
import { parseInlineToolCalls, streamingDisplay, stripCallTags } from "./inline-tools";

/** 用户实测的 DeepSeek DSML 样例（｜ 为全角竖线 U+FF5C） */
const DSML_SAMPLE = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="brain.plan">',
  '<｜｜DSML｜｜ parameter name="input" string="false">{"task": "打包游戏"}</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  '<｜｜DSML｜｜ invoke name="load_doc">',
  '<｜｜DSML｜｜ parameter name="id" string="false">{"id": "editor/preview-build.md"}</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  '<｜｜DSML｜｜ invoke name="editor.state">',
  "</｜｜DSML｜｜ invoke>",
  '<｜｜DSML｜｜ invoke name="project.list">',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

describe("scanTagCalls：DSML 方言", () => {
  it("正常：多 invoke 并行调用全量解析，零参 invoke 也产出", () => {
    const { calls, ranges } = scanTagCalls(DSML_SAMPLE);
    expect(calls.map((c) => c.name)).toEqual(["brain.plan", "load_doc", "editor.state", "project.list"]);
    expect(JSON.parse(calls[0].arguments)).toEqual({ task: "打包游戏" });
    // 同名对象壳解一层：标量参数不套 {"id": {…}} 双层
    expect(JSON.parse(calls[1].arguments)).toEqual({ id: "editor/preview-build.md" });
    expect(JSON.parse(calls[2].arguments)).toEqual({});
    expect(ranges.length).toBeGreaterThanOrEqual(4);
  });

  it("正常：string=\"true\" 参数保持纯文本，无 string 属性的非槽参数不试 JSON", () => {
    const text =
      '<｜dsml｜><｜dsml｜ invoke name="asset.write">' +
      '<｜dsml｜ parameter name="path" string="true">assets/notes.md</｜dsml｜ parameter>' +
      '<｜dsml｜ parameter name="content" string="true">{"不是JSON": 的普通文本</｜dsml｜ parameter>' +
      "</｜dsml｜ invoke></｜dsml｜>";
    const { calls } = scanTagCalls(text);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({
      path: "assets/notes.md",
      content: '{"不是JSON": 的普通文本',
    });
  });

  it("异常：string=\"false\" 声明 JSON 却解析失败 → 残缺载荷只剥离不执行", () => {
    const text = '<｜dsml｜ invoke name="asset.write"><｜dsml｜ parameter name="content" string="false">{"path":"x","content":"半截</｜dsml｜ parameter></｜dsml｜ invoke>';
    const { calls, ranges } = scanTagCalls(text);
    expect(calls).toHaveLength(0);
    expect(ranges).toHaveLength(1);
  });

  it("边界：漏闭合的相邻 invoke（参数体完整）照常执行", () => {
    const text =
      '<x invoke name="scene.list">' +
      '<x invoke name="editor.state">' +
      "</x invoke>";
    const { calls } = scanTagCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["scene.list", "editor.state"]);
  });

  it("边界：正文截断的尾部 invoke 只剥离不执行（防半截参数跑出去）", () => {
    const text = '<x invoke name="asset.write"><x parameter name="content" string="true">写到一半的';
    const { calls, ranges } = scanTagCalls(text);
    expect(calls).toHaveLength(0);
    expect(ranges).toHaveLength(1);
  });

  it("边界：name 槽顶工具名（块级 name 属性缺失）", () => {
    const text = '<x invoke><x parameter name="name">scene.save</x parameter><x parameter name="rel">a.scene</x parameter></x invoke>';
    const { calls } = scanTagCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("scene.save");
    expect(JSON.parse(calls[0].arguments)).toEqual({ rel: "a.scene" });
  });

  it("边界：参数键保留原大小写（camelCase 不被小写化吞掉）", () => {
    const text = '<invoke name="asset.read"><parameter name="startLine">10</parameter><parameter name="endLine">20</parameter></invoke>';
    const { calls } = scanTagCalls(text);
    expect(JSON.parse(calls[0].arguments)).toEqual({ startLine: "10", endLine: "20" });
  });

  it("边界：prose 里的无名 <function> / 属性值同名词不误判", () => {
    const text = '泛型写法 Array<function> 与 <div title="call the tool">说明</div>';
    const { calls, ranges } = scanTagCalls(text);
    expect(calls).toHaveLength(0);
    expect(ranges).toHaveLength(0);
  });
});

describe("scanExoticShells：非标记壳", () => {
  it("正常：python_tag 后的调用对象与 [TOOL_CALLS] 数组", () => {
    const py = '<|python_tag|>{"name": "node.list", "parameters": {}}';
    expect(scanExoticShells(py).calls.map((c) => c.name)).toEqual(["node.list"]);
    const mistral = '[TOOL_CALLS] [{"name": "scene.save", "arguments": {"rel": "a.scene"}}]';
    const { calls } = scanExoticShells(mistral);
    expect(calls.map((c) => c.name)).toEqual(["scene.save"]);
    expect(JSON.parse(calls[0].arguments)).toEqual({ rel: "a.scene" });
  });

  it("边界：非调用形状的数组/对象不消费", () => {
    expect(scanExoticShells("[TOOL_CALLS] [1, 2, 3]").calls).toHaveLength(0);
    expect(scanExoticShells("[TOOL_CALLS] 说这话不带数组").calls).toHaveLength(0);
  });
});

describe("hasTagCallTrace 痕迹检测", () => {
  it("正常：DSML 残骸与参数槽算痕迹，泛型与散文不误伤", () => {
    expect(hasTagCallTrace('<｜｜DSML｜｜ invoke name="x">')).toBe(true);
    expect(hasTagCallTrace("<x parameter name=\"k\">v</x parameter>")).toBe(true);
    expect(hasTagCallTrace("泛型 Array<function> 用法")).toBe(false);
    expect(hasTagCallTrace("普通回复文本")).toBe(false);
  });
});

describe("stripTagCalls 出口净化", () => {
  it("正常：未闭合 DSML 块剔到尾，无名 function 与代码不碰", () => {
    const text = '正文前缀 <｜dsml｜ invoke name="asset.write"><｜dsml｜ parameter name="content">残骸';
    expect(stripTagCalls(text)).toBe("正文前缀");
    const code = "泛型 Array<function> 与无名标记保留";
    expect(stripTagCalls(code)).toBe(code);
  });

  it("空值：无结构标记原样返回", () => {
    expect(stripTagCalls("普通文本")).toBe("普通文本");
    expect(stripTagCalls("")).toBe("");
  });
});

describe("parseInlineToolCalls 集成：DSML 走通用引擎", () => {
  it("正常：完整 DSML 块抠成调用，cleaned 无标记残骸", () => {
    const { calls, cleaned } = parseInlineToolCalls(DSML_SAMPLE);
    expect(calls).toHaveLength(4);
    expect(cleaned).not.toContain("DSML");
    expect(cleaned).not.toContain("invoke");
  });

  it("正常：带前后正文的 DSML 块剔除后正文保留", () => {
    const text = `我来查一下。\n${DSML_SAMPLE}\n稍等。`;
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(4);
    expect(cleaned).toContain("我来查一下。");
    expect(cleaned).toContain("稍等。");
  });

  it("正常：stripCallTags 兜底残骸（解析不出的半截 DSML 不上屏）", () => {
    const raw = '说明文字\n<｜｜DSML｜｜ invoke name="x">\n<｜｜DSML｜｜ parameter name="a">1';
    expect(stripCallTags(raw)).toBe("说明文字");
  });

  it("边界：经典 antml invoke 仍走旧路径不受影响", () => {
    const text = '<invoke name="scene.save"><parameter name="rel">a.scene</parameter></invoke>';
    const { calls } = parseInlineToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["scene.save"]);
  });

  it("streamingDisplay：DSML 半截标记不闪现，完整块消费后正文保留", () => {
    expect(streamingDisplay('说明\n<｜｜DSML｜｜ invoke name="asset')).toBe("说明");
    const done = '说明\n<｜｜DSML｜｜ invoke name="x">\n</｜｜DSML｜｜ invoke>\n正文';
    const shown = streamingDisplay(done);
    expect(shown).toContain("说明");
    expect(shown).toContain("正文");
    expect(shown).not.toContain("DSML");
  });
});

describe("scanDialectCalls 入口", () => {
  it("正常：结构标记优先，无产出时回落非标记壳", () => {
    expect(scanDialectCalls(DSML_SAMPLE).calls).toHaveLength(4);
    expect(scanDialectCalls('<|python_tag|>{"name": "node.list", "parameters": {}}').calls).toHaveLength(1);
    expect(scanDialectCalls("无调用文本").calls).toHaveLength(0);
  });
});
