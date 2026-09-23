import { describe, expect, it } from "vitest";
import {
  cleanedContent,
  hasInlineToolCalls,
  parseInlineToolCalls,
  streamingDisplay,
  stripCallTags,
} from "./inline-tools";

describe("parseInlineToolCalls", () => {
  it("正常：解析 tool+input 形状的调用块", () => {
    const { calls } = parseInlineToolCalls('前置说明\n{ "tool": "scene.list", "input": {} }');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("scene.list");
    expect(JSON.parse(calls[0].arguments)).toEqual({});
    expect(calls[0].id).toMatch(/^inline_/);
  });

  it("正常：一段正文多个调用块全部解析", () => {
    const text = [
      '{ "tool": "editor.state", "input": {} }',
      '中间文字',
      '{ "tool": "node.add", "input": { "kind": "mesh", "subtype": "box" } }',
    ].join("\n");
    const { calls } = parseInlineToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["editor.state", "node.add"]);
    expect(JSON.parse(calls[1].arguments).kind).toBe("mesh");
  });

  it("正常：name+arguments 形状（OpenAI 风格）同样识别", () => {
    const { calls } = parseInlineToolCalls(
      '{"name": "asset.read", "arguments": {"path": "a/b.txt"}}',
    );
    expect(calls[0].name).toBe("asset.read");
    expect(JSON.parse(calls[0].arguments).path).toBe("a/b.txt");
  });

  it("正常：<invoke> XML 形态解析（多参数）", () => {
    const text = [
      "<invoke name=\"asset.read\">",
      "  <parameter name=\"path\">assets\\Main.scene</parameter>",
      "  <parameter name=\"root\">D:\\proj</parameter>",
      "</invoke>",
    ].join("\n");
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("asset.read");
    const args = JSON.parse(calls[0].arguments);
    expect(args.path).toBe("assets\\Main.scene");
    expect(args.root).toBe("D:\\proj");
  });

  it("正常：XML 实体解码（&lt; &amp; &quot;）", () => {
    const text =
      '<invoke name="asset.write"><parameter name="content">a &lt; b &amp;&amp; c &quot;d&quot;</parameter></invoke>';
    const { calls } = parseInlineToolCalls(text);
    expect(JSON.parse(calls[0].arguments).content).toBe('a < b && c "d"');
  });

  it("正常：<tool_call> 包裹的 JSON 剥壳识别", () => {
    const text = '前缀\n<tool_call>\n{"name": "scene.list", "arguments": {}}\n</tool_call>';
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["scene.list"]);
    expect(cleaned).not.toContain("tool_call");
  });

  it("异常：残缺壳（标签垃圾裹着 JSON）仍能捞出调用并整壳剔除", () => {
    const text = [
      "<tool_call>",
      '<function=name="tool_calls">',
      '{"name": "brain.plan", "arguments": {"task": "创建3D项目"}}',
      "</parameter>",
      "</function>",
      "</tool_call>",
    ].join("\n");
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("brain.plan");
    expect(JSON.parse(calls[0].arguments).task).toBe("创建3D项目");
    expect(cleaned).not.toContain("tool_call");
    expect(cleaned).not.toContain("brain.plan");
  });

  it("正常：<function=…> + <parameter=name/input> 等号参数槽方言", () => {
    const text = [
      "<tool_call>",
      "<function=tool_call>",
      "<parameter=name>",
      "project.create",
      "</parameter>",
      "<parameter=input>",
      '{"name":"RotCube"}',
      "</parameter>",
      "</function>",
      "</tool_call>",
    ].join("\n");
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("project.create");
    expect(JSON.parse(calls[0].arguments)).toEqual({ name: "RotCube" });
    expect(cleaned).not.toContain("project.create");
    expect(cleaned).not.toContain("parameter");
  });

  it("正常：<function=工具名> 裸等号方言 + 逐参数槽（多行值）——截图挂死现场", () => {
    const text = [
      "<tool_call>",
      "  <function=asset.read>",
      "    <parameter=path>",
      "    assets/Main.scene",
      "    </parameter>",
      "  </function>",
      "</tool_call>",
      "<tool_call>",
      "  <function=asset.read>",
      "    <parameter=path>",
      "    src/main.ts",
      "    </parameter>",
      "  </function>",
      "</tool_call>",
    ].join("\n");
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.name)).toEqual(["asset.read", "asset.read"]);
    expect(JSON.parse(calls[0].arguments).path).toBe("assets/Main.scene");
    expect(JSON.parse(calls[1].arguments).path).toBe("src/main.ts");
    expect(cleaned).not.toContain("tool_call");
    expect(cleaned).not.toContain("asset.read");
  });

  it("正常：<function=工具名> 零参调用（无参数槽）同样发起", () => {
    const text = "<tool_call>\n<function=node.list>\n</function>\n</tool_call>";
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("node.list");
    expect(JSON.parse(calls[0].arguments)).toEqual({});
  });

  it("正常：标准 invoke 且参数恰好名为 name——不得吞掉工具名", () => {
    const text =
      '<invoke name="project.create"><parameter name="name">RotCube</parameter></invoke>';
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("project.create");
    expect(JSON.parse(calls[0].arguments)).toEqual({ name: "RotCube" });
  });

  it("边界：input 槽的值不是 JSON 对象时回落为 {槽名: 值}", () => {
    const text = '<invoke name="asset.write"><parameter name="input">纯文本内容</parameter></invoke>';
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments)).toEqual({ input: "纯文本内容" });
  });

  it("正常：<function name=\"…\"> 空格属性形态 + 逐参数入参", () => {
    const text =
      '<function name="node.add">\n  <parameter name="kind">mesh</parameter>\n  <parameter name="subtype">sphere</parameter>\n</function>';
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("node.add");
    expect(JSON.parse(calls[0].arguments)).toEqual({ kind: "mesh", subtype: "sphere" });
  });

  it("边界：壳内没有有效调用 JSON 时整壳保留不误吞", () => {
    const text = "<tool_call>\n这不是 json 也不是调用\n</tool_call>";
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it("cleaned：invoke 块从正文剔除，前后散文保留", () => {
    const text = [
      "我去读场景。",
      '<invoke name="asset.read"><parameter name="path">a</parameter></invoke>',
      "稍等。",
    ].join("\n");
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(cleaned).not.toContain("invoke");
    expect(cleaned).toContain("我去读场景。");
    expect(cleaned).toContain("稍等。");
  });

  it("边界：字符串里的花括号不破坏配平", () => {
    const { calls } = parseInlineToolCalls(
      '{ "tool": "asset.write", "input": { "content": "函数体 { return \\"}\\"; }" } }',
    );
    expect(calls).toHaveLength(1);
    const content = JSON.parse(calls[0].arguments).content as string;
    expect(content).toContain("}");
  });

  it("边界：普通 JSON 数据（无 tool/name）不误吞", () => {
    const text = '配置示例 { "mode": "fast", "n": 1 } 保持原样';
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(0);
    expect(cleaned).toBe(text);
  });

  it("异常：非法 JSON 块跳过不抛错，后续合法块仍解析", () => {
    const text = '{ tool: 圧根不是json } 之后 { "tool": "scene.save", "input": {} }';
    const { calls } = parseInlineToolCalls(text);
    expect(calls.map((c) => c.name)).toEqual(["scene.save"]);
  });

  it("异常：缺 input 字段或名字非法的块不识别", () => {
    const text = '{ "tool": "node.add" } { "tool": 42, "input": {} } { "name": "", "input": {} }';
    expect(parseInlineToolCalls(text).calls).toHaveLength(0);
  });

  it("空值：空正文/无花括号返回空且正文原样", () => {
    expect(parseInlineToolCalls("").calls).toHaveLength(0);
    const plain = "纯文本回复，没有调用";
    const r = parseInlineToolCalls(plain);
    expect(r.calls).toHaveLength(0);
    expect(r.cleaned).toBe(plain);
  });
});

describe("hasInlineToolCalls / cleanedContent", () => {
  it("has：有调用块为 true，普通正文为 false", () => {
    expect(hasInlineToolCalls('{ "tool": "preview.open", "input": {} }')).toBe(true);
    expect(hasInlineToolCalls("普通回答")).toBe(false);
  });

  it("cleaned：抠掉调用块并收敛空行", () => {
    const out = cleanedContent('我先查状态。\n\n{ "tool": "editor.state", "input": {} }\n\n\n\n再执行。');
    expect(out).not.toContain("editor.state");
    expect(out).toContain("我先查状态。");
    expect(out).toContain("再执行。");
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("回归（截图案例）：围栏包裹的调用整块消费，不残留孤立 ```json 围栏壳", () => {
    const text = '```json\n{ "tool": "scene.list", "input": {} }\n```';
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(cleaned).not.toContain("```");
    expect(cleaned.trim()).toBe("");
    // 正文中的围栏调用同样吸附，前后散文保留
    const out = cleanedContent('好的。\n```json\n{"tool":"preview.open","input":{}}\n```\n完成。');
    expect(out).toContain("好的。");
    expect(out).toContain("完成。");
    expect(out).not.toContain("```");
  });

  it("边界：空围栏（含模型直出的 ```json 空块）清理，有内容的真代码块不误吞", () => {
    expect(cleanedContent("```json\n```").trim()).toBe("");
    expect(cleanedContent("```\n\n```").trim()).toBe("");
    const code = "```ts\nconst a = { x: 1 };\n```";
    expect(cleanedContent(code)).toContain("const a");
    expect(cleanedContent(code).match(/```/g)?.length).toBe(2);
  });
});

describe("stripCallTags 残骸净化", () => {
  it("回归：残缺方言块（tool_call 壳无闭合 + function=invoke 无工具名）整体剔除", () => {
    const text = [
      "<tool_call>",
      "<function=invoke>",
      '<parameter name="path">assets/Main.scene</parameter>',
      "</invoke>",
    ].join("\n");
    const out = stripCallTags(text);
    expect(out).not.toContain("tool_call");
    expect(out).not.toContain("invoke");
    expect(out).not.toContain("parameter");
    expect(out).not.toContain("Main.scene");
  });

  it("边界：闭合完整块剔除、普通正文与数学比较符不误伤", () => {
    expect(stripCallTags("结论：a<b 成立")).toBe("结论：a<b 成立");
    expect(
      stripCallTags('说明文字\n<invoke name="scene.open">\n<parameter name="rel">a.scene</parameter>\n</invoke>'),
    ).toBe("说明文字");
  });
});

describe("streamingDisplay", () => {
  it("完整调用块剔除，散文保留", () => {
    const out = streamingDisplay('先看状态\n{ "tool": "editor.state", "input": {} }');
    expect(out).not.toContain("editor.state");
    expect(out).toBe("先看状态");
  });

  it("尾部未写完的调用载荷整体隐藏（嵌套括号也算）", () => {
    const partial = '我规划一下…\n{"tool": "brain.plan", "input": {"task": "创建3D项目，建立地面';
    expect(streamingDisplay(partial)).toBe("我规划一下…");
    const deeper = '{"tool": "x", "input": {"a": {"b": 1';
    expect(streamingDisplay(deeper)).toBe("");
  });

  it("未闭合的调用标签隐藏，普通文本中的孤立 < 不误伤", () => {
    expect(streamingDisplay("开始\n<invoke name=\"asset.read\"")).toBe("开始");
    expect(streamingDisplay("开始\n<tool_call>")).toBe("开始");
    expect(streamingDisplay("比较 a < b 的大小")).toBe("比较 a < b 的大小");
  });

  it("非调用数据（不含 tool/name 键）正常显示", () => {
    const data = '示例 {"mode": "fast", "n": 1';
    expect(streamingDisplay(data)).toBe(data);
  });

  it("回归（截图案例）：围栏调用的流式半截不闪 ```json 壳，空围栏清空", () => {
    expect(streamingDisplay("我查一下：\n```json\n")).toBe("我查一下：");
    expect(streamingDisplay('我查一下：\n```json\n{"tool": "scene.list", "input"')).toBe("我查一下：");
    expect(streamingDisplay("```json\n```")).toBe("");
    // 真代码块内容到达后正常显示，围栏不丢
    const code = "示例：\n```ts\nconst a = 1;\n```";
    const shown = streamingDisplay(code);
    expect(shown).toContain("const a = 1;");
    expect(shown.match(/```/g)?.length).toBe(2);
  });
});

describe("parseInlineToolCalls Markdown 标签方言", () => {
  it("回归（截图案例）：调用+伪结果正文抠出真调用，cleaned 只剩占位", () => {
    const text =
      "（已发起工具调用）\n\n" +
      '**工具调用：** `load_skill` `{"id":"tve-scripting"}`\n\n' +
      '**结果：** `{"id":"tve-scripting","title":"tve 脚本编写","content":"# 长文档"}`';
    const { calls, cleaned } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("load_skill");
    expect(JSON.parse(calls[0].arguments)).toEqual({ id: "tve-scripting" });
    expect(cleaned).toBe("（已发起工具调用）");
  });

  it("边界：伪结果 JSON 不产生第二个调用", () => {
    const text = '**工具调用：** `x.y` {"a":1}\n**结果：** {"name":"伪","args":{}}';
    const { calls } = parseInlineToolCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("x.y");
  });

  it("streamingDisplay：半截标签调用不闪现，普通叙述保留", () => {
    expect(streamingDisplay('我先发起\n**工具调用：** `load_skill` {"id":"tv')).toBe("我先发起");
    expect(streamingDisplay("结论：一切正常")).toBe("结论：一切正常");
  });

  it("stripCallTags：救援耗尽后的方言残骸整行剔除", () => {
    const out = stripCallTags('（已发起工具调用）\n\n**工具调用：** `load_skill` {"id":');
    expect(out).toBe("（已发起工具调用）");
  });
});
