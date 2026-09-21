---
name: tve-self-evolution
description: TvE Hub 技能文档与代码的协同演化系统：漂移检测网（pnpm skills:check）+ 代码变更→文档单元的同步映射表 + 更新手册。凡改了 API/命令/引擎接口/覆盖率阈值/操作入口之后要同步技能文档、skills:check 或 ci:local 的 skills 步红了、或要新增技能单元，一律用本技能。
---

# 自演化系统（文档跟着代码长）

核心思想：**技能文档是契约，不是说明文**——它们被校验器逐条核对，代码变更若
让契约失真，`pnpm skills:check` 会红。闭环：

```
改代码 → 按 drift-map 同步对应技能单元（同一批改动里完成）
       → pnpm skills:check（秒级，引用路径/行号逐条核对）
       → pnpm ci:local（提交前整链，skills 是第一步）
```

## 组成

- **检测网** `scripts/check-skills.mjs`（pnpm skills:check）：frontmatter 结构、
  行数预算（软 200/硬 260）、`src|scripts|tests|public` 路径引用存在性、
  `path:line` 行号有效性。宁漏报不误报：围栏代码块不查、`*.spec.ts` 缺失只告警
  （推荐补测的示范文件）、public/engine 产物不查。
- **同步映射**：references/drift-map.md —— 改了什么 → 动哪些单元 → 怎么验证。
- **更新手册**：references/update-playbooks.md —— 四类高频变更的分步剧本。
- 已知告警白名单形态：不存在但**故意**引用的路径（推荐补测的 spec）以告警
  形式存在，不算失败——它们是"文档领先于代码"的待办清单。

## 三条演化纪律

1. **同批同步**：改 API/命令/引擎接口的提交，必须同批更新受影响单元——
   不允许"文档下个迭代再说"（校验器会拦住大部分，但拦不住语义漂移）。
2. **行号廉价、语义昂贵**：校验器只能拦"文件没了/行号越界"；方法改名但路径
   行数恰好不变时拦不住——凡改函数签名，回看引用它的单元文件的契约表。
3. **新单元走三段式**：新增技能单元必须有 契约/操作面 + 使用例（真实 `文件:行号`）
   + 测试例（真实 spec 或标注"推荐写法"）——这是本组单元的可点检标准。

## 路由

| 场景 | 读 |
|---|---|
| 我改了 X，要动哪些文档 | references/drift-map.md |
| 具体怎么改（分步） | references/update-playbooks.md |
| 校验器规则细节 | `tve-local-ci` references/gate-chains.md |

## 姊妹技能

链路执行：`tve-local-ci`；自主决策（何时触发同步）：`tve-agent-autonomy`。
