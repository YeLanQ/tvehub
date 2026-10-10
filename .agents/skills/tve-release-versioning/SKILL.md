---
name: tve-release-versioning
description: TvE Hub 语义化版本管理与发版流程：版本号单一事实源（src-tauri/tauri.conf.json）与三处同步、version:sync/check/bump 命令族、CHANGELOG.md 全量再生、发布锚点（chore(version) 裸版本主题或 git tag）与落锚三步发版。凡要设置/递增版本号、发版出包、再生 CHANGELOG、三处版本号不一致、"未发布"段如何发布、锚点没生效积压，一律先读本技能。
---

# 语义化版本管理与发版

版本格式 `major.minor.patch[+构建号]`（scripts/sync-version.mjs:55）。事实源 =
`src-tauri/tauri.conf.json` 的 version（exe 文件版本资源与首页 `__APP_VERSION__` 都取它），
传播到 package.json 与 src-tauri/Cargo.toml；Cargo.lock 不手改，随 cargo build 再生。

## 命令族

| 命令 | 行为 |
|---|---|
| `pnpm version:sync` | 校准 package.json / Cargo.toml 到事实源（默认动作） |
| `pnpm version:check` | 只校验不写入，不一致退出码 1（自检/CI 用；dev/build 链首挂的是 version:sync 直接对齐） |
| `pnpm version:bump [级别]` | 递增事实源再同步；级别 major/minor/patch/build/auto |
| `pnpm changelog` | 全量再生 CHANGELOG.md（幂等，文件是产物勿手改）；`--check` 只校验 |

bump 级别语义（scripts/sync-version.mjs:67）：

- major/minor/patch：清掉 `+N`（下次 bump build 从 +1 重计）；递增后**自动再生 CHANGELOG.md**，
  新版本段以「未发布」出现，发版提交落锚后 `pnpm changelog` 补日期。
- build：递增 `+N`；非纯数字构建号报错要求手改事实源。
- auto：按未发布提交判定 feat→minor、fix→patch、破坏性→major（0.x 破坏性只升 minor）；
  无未发布提交则报错，需显式指定级别。

**要设置具体版本号**（如 1.0.0+1）：命令族只支持递增——直接改事实源后跑
`pnpm version:sync` 传播；勿直接改下游两处（会被判漂移，且 exe 资源只认事实源）。

## CHANGELOG 与发布锚点

CHANGELOG.md 由 git 历史全量再生：锚点切段 scripts/changelog-core.mjs:67，段渲染
scripts/gen-changelog.mjs:38。发布锚点＝以下之一（tag 优先于主题，scripts/changelog-core.mjs:16
正则**全串匹配**）：

- git tag 指向的提交（tag 名即版本名）；或
- 提交主题形如 `chore(version): vX.Y.Z+N` / 裸版本号——**版本号后带任何后缀文字都匹配失败**。

锚点之间的提交归较新的锚点段；最新锚点之后为「未发布」段（版本号取事实源）；锚点提交本身
只是标记不进段，`chore(version)` 版本标记提交在条目里剔除。

## 发版剧本（落锚三步）

```bash
git add -A
git commit -m "chore(version): v1.0.0+1"             # ① 落锚：主题裸版本号，说明写提交正文
pnpm changelog                                        # ② 再生：未发布段落日期，未发布段消失
git add CHANGELOG.md && git commit --amend --no-edit  # ③ 日期并回发版提交（锚点认主题不认 hash）
```

- 直接指定版本的等价路径（如 0.1.4+1 → 1.0.0+1）：改事实源 → `pnpm version:sync` → 落锚三步；
  走 bump 则是 `version:bump major`（得 1.0.0，再生 CHANGELOG）+ `version:bump build`（得 +1）。
- 发版前自检：`pnpm version:check && pnpm changelog --check`。

已知坑（实证）：v0.1.4+1 的发版提交主题带括号后缀（`chore(version): v0.1.4+1（README…）`）
→ 正则不匹配且无同名 tag → 未成锚点，其后 126 个提交积压进未发布段。补救 = 补打同名 tag
（`git tag v0.1.4+1 <hash>` 后重跑 `pnpm changelog`）或接受并入下一段。

## 使用例

- 出包只递构建号：`pnpm version:bump build`（1.0.0 → 1.0.0+1 → 1.0.0+2）。
- 查当前分段与未发布积压：

```bash
node -e "import('./scripts/changelog-core.mjs').then(m => \
  console.log(m.splitByRelease(process.cwd()).map(s => [s.label, s.commits.length])))"
```

- auto 递增前预演级别判定：scripts/changelog-core.mjs:109 的 autoBumpLevel 即判定函数，
  同上方式单跑可看「会升到哪级」再决定是否执行 bump。

## 测试例

当前无 spec（scripts 工具链无单测惯例；vitest 收录面为 `src` 下 spec，见 vitest.config.ts:20，
补测需扩 include）。推荐写法——changelog-core 纯函数可直测：

```ts
// tests/versioning.spec.ts（推荐落位，待补；vitest include 加 "tests/**/*.spec.ts" 后生效）
import { describe, expect, it } from "vitest";
import { autoBumpLevel } from "../scripts/changelog-core.mjs";

const c = (over = {}) => ({
  hash: "h", date: "2026-10-10", subject: "x",
  type: "feat", scope: "", breaking: false, text: "x", ...over,
});

describe("autoBumpLevel 语义化判定", () => {
  it("feat 提交 → minor", () => expect(autoBumpLevel([c()], 1)).toBe("minor"));
  it("fix 提交 → patch", () => expect(autoBumpLevel([c({ type: "fix" })], 1)).toBe("patch"));
  it("1.x 破坏性 → major；0.x 破坏性按 semver 惯例只升 minor", () => {
    expect(autoBumpLevel([c({ breaking: true })], 1)).toBe("major");
    expect(autoBumpLevel([c({ breaking: true })], 0)).toBe("minor");
  });
  it("全为版本标记提交 → null（无可发布内容）", () => {
    expect(autoBumpLevel([c({ type: "chore", scope: "version", text: "v1.0.0" })], 1)).toBeNull();
  });
});
```

## 姊妹技能

门禁链与 `--check` 类门禁语义：`tve-local-ci`；文档同步与 drift-map：`tve-self-evolution`。
