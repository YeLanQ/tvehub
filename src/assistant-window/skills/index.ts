// 助手技能注册表：精简索引常驻系统提示词，全文经 load_skill 工具按需注入
// （description 即路由：索引行写清"何时使用"，模型自行选择加载）。

import { DOMAIN_SKILLS, type AssistantSkill } from "./domain";
import { WORKFLOW_SKILLS } from "./workflow";

export type { AssistantSkill };

export const SKILLS: AssistantSkill[] = [...DOMAIN_SKILLS, ...WORKFLOW_SKILLS];

export function findSkill(id: string): AssistantSkill | null {
  return SKILLS.find((s) => s.id === id) ?? null;
}

/** 系统提示词里的精简索引（id | 名称 — 何时使用） */
export function skillIndexPrompt(): string {
  const lines = SKILLS.map((s) => `- ${s.id}（${s.name}）：${s.description}`);
  return ["## 可加载技能索引", "需要某技能的完整内容时，调用 load_skill({ id }) 获取。", ...lines].join(
    "\n",
  );
}

/** 关键词命中：返回最匹配的技能（用于发送前自动附加；无命中返回 null） */
export function routeSkill(text: string): AssistantSkill | null {
  const t = text.toLowerCase();
  const RULES: Array<[string, RegExp]> = [
    ["tve-scripting", /脚本|component|@property|engine\.|tve|onupdate|预制.*脚本/],
    ["tve-operations", /怎么(操作|做|用)|快捷键|快捷鍵|面板|导入|绘制|动画编辑器|预览|构建|检查器/],
    ["tve-graph", /节点图|图窗口|场景图|op\.|fsm\.container|行为树容器|var\.get/],
    ["tve-whiteboard", /白板|放映|画板|svg/],
    ["tve-engine", /引擎|序列化|产物|public\/engine|player\.mjs|工坊|repos/],
    ["clarify", /^帮我?做.{0,6}(一个|一套|些)/],
    ["debugging-discipline", /报错|异常|不对|坏了|白屏|不生效|为什么.*不/],
  ];
  for (const [id, re] of RULES) {
    if (re.test(t)) return findSkill(id);
  }
  return null;
}
