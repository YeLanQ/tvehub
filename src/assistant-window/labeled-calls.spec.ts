// 标签方言解析回归：**工具调用：** `name` {json} + 伪造「**结果：**」块的
// 抠取与剔除——弱模型把调用写进正文时循环必须真正执行而不是空转复读。
import { describe, expect, it } from "vitest";
import {
  hasLabeledCallTrace,
  labeledTailStart,
  scanLabeledCalls,
  stripLabeledCalls,
} from "./labeled-calls";

describe("scanLabeledCalls 严格解析", () => {
  it("正常：加粗 + 反引号包裹的名字与参数（截图方言）抠成调用", () => {
    const text = '前置说明\n**工具调用：** `load_skill` `{"id":"tve-scripting"}`';
    const { calls, ranges } = scanLabeledCalls(text, false);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("load_skill");
    expect(JSON.parse(calls[0].arguments)).toEqual({ id: "tve-scripting" });
    expect(ranges).toHaveLength(1);
  });

  it("正常：无加粗无反引号的裸方言也识别", () => {
    const text = '工具调用：scene.save {"path": "assets/Main.scene"}';
    const { calls } = scanLabeledCalls(text, false);
    expect(calls.map((c) => c.name)).toEqual(["scene.save"]);
    expect(JSON.parse(calls[0].arguments)).toEqual({ path: "assets/Main.scene" });
  });

  it("正常：列表项与全角括号包裹变体", () => {
    const list = '- **工具调用：** node.add {"name":"Box"}';
    expect(scanLabeledCalls(list, false).calls.map((c) => c.name)).toEqual(["node.add"]);
    const bracket = "【工具调用】scene.list {}";
    expect(scanLabeledCalls(bracket, false).calls.map((c) => c.name)).toEqual(["scene.list"]);
  });

  it("边界：叙述性标签（无参数花括号）不当调用，正文不消费", () => {
    const text = "先看工具调用：brain.plan 拿策略再动手";
    const r = scanLabeledCalls(text, false);
    expect(r.calls).toHaveLength(0);
    expect(r.ranges).toHaveLength(0);
  });

  it("异常：参数 JSON 残缺不当作调用（lenient 才按行剔除）", () => {
    const text = '**工具调用：** `load_skill` {"id":';
    expect(scanLabeledCalls(text, false).calls).toHaveLength(0);
    expect(scanLabeledCalls(text, true).ranges).toHaveLength(1);
  });
});

describe("伪结果块剔除", () => {
  it("正常：调用块后紧跟的「结果：」JSON 一并消费，prose 结果不动", () => {
    const text =
      '**工具调用：** `load_skill` `{"id":"tve"}`\n\n' +
      '**结果：** `{"id":"tve","title":"tve 脚本编写","content":"# 长文档"}`\n\n' +
      "以上请查收。";
    const { calls, ranges } = scanLabeledCalls(text, false);
    expect(calls).toHaveLength(1);
    const stripped = stripLabeledCalls(text);
    expect(stripped).toBe("以上请查收。");
    expect(stripped).not.toContain("tve 脚本编写");
    expect(ranges).toHaveLength(1);
    // 伪结果 JSON 不产生第二个调用（缺 tool/name + input 形状）
    expect(calls[0].name).toBe("load_skill");
  });

  it("边界：与调用不相邻的「结果：」标签不误删", () => {
    const text = "**工具调用：** `x` {}\n\n隔了很远的结果：只是普通文字";
    const stripped = stripLabeledCalls(text);
    expect(stripped).toContain("结果：只是普通文字");
  });

  it("边界：紧邻的 prose 结果行——严格保留，lenient 按行剔除", () => {
    const text = "**工具调用：** `x` {}\n\n结果：只是普通文字\n收尾";
    const strict = scanLabeledCalls(text, false);
    expect(strict.calls).toHaveLength(1);
    expect(strict.ranges).toHaveLength(1);
    expect(stripLabeledCalls(text)).toBe("收尾");
  });
});

describe("hasLabeledCallTrace 痕迹检测", () => {
  it("正常：完整/残缺参数的标签调用都算痕迹，叙述不算", () => {
    expect(hasLabeledCallTrace('**工具调用：** `load_skill` `{"id":"x"}`')).toBe(true);
    expect(hasLabeledCallTrace('**工具调用：** `load_skill` {"id":')).toBe(true);
    expect(hasLabeledCallTrace("工具调用：brain.plan 拿策略")).toBe(false);
    expect(hasLabeledCallTrace("普通回复")).toBe(false);
  });

  it("边界：调用清单式总结（无花括号）不算痕迹", () => {
    expect(hasLabeledCallTrace("本轮工具调用：project.open、node.add 均成功")).toBe(false);
  });
});

describe("labeledTailStart 流式尾部", () => {
  it("正常：半截参数与刚流出的名字都从标签处截断", () => {
    const partial = '我先发起\n**工具调用：** `load_skill` {"id":"tv';
    expect(labeledTailStart(partial)).toBe("我先发起\n".length);
    const nameOnly = "说明\n**工具调用：** `load_skill`";
    expect(labeledTailStart(nameOnly)).toBe("说明\n".length);
  });

  it("边界：完整块与名字后跟叙述的不截", () => {
    expect(labeledTailStart('**工具调用：** `x` {"a":1}')).toBe(-1);
    expect(labeledTailStart("工具调用：brain.plan 拿策略")).toBe(-1);
    expect(labeledTailStart("没有标签的文本")).toBe(-1);
  });
});

describe("stripLabeledCalls 出口净化", () => {
  it("正常：剔除调用与伪结果行，保留其余文本", () => {
    const text =
      "（已发起工具调用）\n\n**工具调用：** `load_skill` `{\"id\":\"tve\"}`\n\n**结果：** `{\"ok\":true}`";
    const out = stripLabeledCalls(text);
    expect(out).toBe("（已发起工具调用）");
  });

  it("空值：无标签文本原样返回", () => {
    const text = "普通总结文本";
    expect(stripLabeledCalls(text)).toBe(text);
    expect(stripLabeledCalls("")).toBe("");
  });
});
