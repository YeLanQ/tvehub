// 场景节点编辑命令：层级面板/视口/属性面板的写操作与 devtools 共用同一执行路径。
// 写仍由 engine 执行（乐观应用 → 后端提交 → 撤销历史）；命令层只负责
// 类型解析（geometry/light/skybox/脚本节点）、命名与 guard（根节点/成环/子孙去重）。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { prompt } from "../lib/prompt";
import { api } from "../../lib/api";
import { registerCommand } from "./registry";
import { isEditingText } from "./context";
import { currentTransform, mergeTransformSnapshot, parseNodeSetArgs } from "./nodeSet";
import type { MoveTarget } from "../../framework/scene/SceneClient";
import type { JsonRecord, Vec3 } from "../../framework/prototype/types";

import type { GeometryKind } from "../../framework/mesh/geometry";
import type { LightKind } from "../../framework/prototype/nodes/LightNode";
import type { SkyboxKind } from "../../framework/prototype/nodes/SkyboxNode";
import { FOG_KINDS } from "../../framework/fog/types";
import { isTerrainAssetRel, parseTerrainSettings } from "../../framework/terrain";

const GEOMETRY_KINDS: GeometryKind[] = [
  "box", "sphere", "plane", "quad", "cylinder", "cone", "torus", "capsule",
];
const LIGHT_KINDS: LightKind[] = ["point", "directional", "ambient", "spot"];
const SKYBOX_KINDS: SkyboxKind[] = ["cube", "procedural"];

function editor() {
  return getEditorStore();
}

function engine() {
  return getEditorStore().engine;
}

function graph() {
  return getEditorStore().engine.graph;
}

/** 解析节点新增参数（未知类型回退安全默认，与历史 UI/devtools 语义一致） */
function asSubtype<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback;
}

/** node.add 可选 position（{x,y,z}，拖放落位）；非法/缺省回退引擎默认出生 */
function asPosition(v: unknown): Vec3 | undefined {
  if (!v || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : undefined;
}

registerCommand({
  id: "node.add",
  label: "添加节点",
  group: "节点",
  expose: true,
  description:
    "在指定父节点下新增节点（kind: group/mesh/light/camera/skybox/fog/audio/particle/terrain/nav/logic/script/model；mesh 可带 subtype 几何，light 可带 subtype 灯光，skybox 可带 subtype 天空，fog 可带 subtype 雾类型，nav 可带 subtype 导航节点（area/agent），script 用 rel/path=脚本 .ts 相对路径，model/audio/terrain 用 path 或 rel 资产路径；parentId 或 parent 指定父节点，缺省挂根）",
  run: async (_ctx, args: any) => {
    const st = editor();
    if (!st.state.mounted) throw new Error("编辑器未就绪，无法添加节点");
    // parent 别名：模型常写 parent（值可为节点 id 或 "root"），与 parentId 等价
    const parentRaw = args?.parentId ?? args?.parent;
    const parentId = parentRaw ? String(parentRaw) : undefined;
    const kind = String(args?.kind ?? args?.type ?? "group").toLowerCase();
    const subtype = args?.subtype !== undefined ? String(args.subtype) : undefined;
    let node;
    switch (kind) {
      case "group":
      case "node":
        node = engine().addEmptyGroup(parentId);
        break;
      case "mesh":
      case "meshnode":
        node = engine().addMesh(
          asSubtype(GEOMETRY_KINDS, subtype ?? args?.geometry, "box"),
          parentId,
        );
        break;
      case "light":
      case "lightnode":
        node = engine().addLight(
          asSubtype(LIGHT_KINDS, subtype ?? args?.lightKind, "point"),
          parentId,
        );
        break;
      case "camera":
      case "cameranode":
        node = engine().addCamera(parentId);
        break;
      case "skybox":
      case "skyboxnode":
        node = engine().addSkybox(
          asSubtype(SKYBOX_KINDS, subtype ?? args?.skyKind, "procedural"),
          parentId,
        );
        break;
      case "fog":
      case "fognode":
        node = engine().addFog(
          asSubtype(FOG_KINDS, subtype ?? args?.fogKind, "linear"),
          parentId,
        );
        break;
      case "audio":
      case "audionode": {
        // 可选 path：直接绑定音频资产（资产面板「添加到场景」）
        const audioSrc = args?.path ?? args?.rel;
        node = engine().addAudio(parentId, audioSrc !== undefined && audioSrc !== null ? String(audioSrc) : "");
        break;
      }
      case "particle":
      case "particles":
      case "particlesystem":
      case "particlesystemnode":
        node = engine().addParticleSystem(parentId);
        break;
      case "nav":
      case "navarea":
      case "navagent": {
        // nav:<area|agent>（裸 "nav" = 区域）；导航区域覆盖范围自动取所采样地形
        const navKind = kind === "nav" ? (subtype ?? "area") : kind === "navarea" ? "area" : "agent";
        if (navKind === "agent") node = engine().addNavAgent(parentId);
        else node = engine().addNavArea(parentId);
        break;
      }
      case "logic":
      case "fsm":
      case "fsmrunner":
      case "bt":
      case "btrunner": {
        // logic:<fsm|bt>（裸 "fsm"/"bt" 亦可）；运行器建好后经检查器绑定逻辑资产
        const logicKind = kind.startsWith("logic")
          ? (subtype ?? "fsm")
          : kind.startsWith("fsm")
            ? "fsm"
            : "bt";
        if (logicKind === "bt") node = engine().addBtRunner(parentId);
        else if (logicKind === "fsm") node = engine().addFsmRunner(parentId);
        else throw new Error(`未知逻辑运行器类型: logic:${logicKind}（应为 fsm/bt）`);
        break;
      }
      case "terrain":
      case "terrainnode": {
        // 可选 path：直接绑定 .terrain 资产（资产面板「添加到场景」/devtools），
        // 快照资产设置到节点（运行时不读资产文件，设置内嵌在节点上）
        const terrainSrc = args?.path ?? args?.rel;
        const terrainPath = terrainSrc !== undefined && terrainSrc !== null ? String(terrainSrc) : "";
        if (terrainPath) {
          if (!isTerrainAssetRel(terrainPath)) {
            throw new Error(`非地形资产: ${terrainPath}（应为 .terrain）`);
          }
          const root = getProjectStore().currentPath;
          if (!root) throw new Error("未打开项目，无法读取地形资产");
          const text = await api.readText(root, terrainPath);
          const doc = JSON.parse(text) as { settings?: unknown };
          node = engine().addTerrain(parentId, {
            asset: terrainPath,
            terrain: parseTerrainSettings(doc.settings),
          });
        } else {
          node = engine().addTerrain(parentId);
        }
        break;
      }
      case "ui":
      case "uicanvas":
      case "uiimage":
      case "uitext":
      case "uibutton":
      case "uilayout": {
        // ui:<canvas|text|image|button|layout>（裸 "ui" = 画布）；Widget 建议挂在画布下
        const uiKind = kind === "ui" ? (subtype ?? "canvas") : kind.startsWith("ui") ? kind.slice(2) : (subtype ?? "canvas");
        switch (uiKind) {
          case "canvas": {
            // 画布渲染尺寸默认取项目设置（设计分辨率按屏幕方向定向）
            const ps = getProjectStore();
            let w = Math.max(1, Math.round(ps.designWidth));
            let h = Math.max(1, Math.round(ps.designHeight));
            if (ps.orientation === "portrait" && w > h) [w, h] = [h, w];
            if (ps.orientation === "landscape" && h > w) [w, h] = [h, w];
            node = engine().addUICanvas(parentId, {
              designWidth: w,
              designHeight: h,
            });
            break;
          }
          case "text":
            node = engine().addUIText(parentId);
            break;
          case "image":
            node = engine().addUIImage(parentId);
            break;
          case "button":
            node = engine().addUIButton(parentId);
            break;
          case "layout":
            node = engine().addUILayout(parentId);
            break;
          default:
            throw new Error(`未知 UI 节点类型: ui:${uiKind}（应为 canvas/text/image/button/layout）`);
        }
        break;
      }
      case "script":
      case "scriptnode": {
        // 脚本路径多别名：模型惯写 rel/path，与历史契约 scriptRel/subtype 等价
        const rel = subtype ?? args?.scriptRel ?? args?.rel ?? args?.path;
        if (!rel)
          throw new Error(
            "脚本节点缺少脚本路径：用 rel（或 path/scriptRel/subtype）= 如 src/Player.ts 的 .ts 资产相对路径",
          );
        const nt = getScriptsStore().scriptNodeTypes().find((s) => s.rel === rel);
        node = engine().addScriptNode(String(rel), nt?.nodeType ?? { kind: "node" }, parentId);
        break;
      }
      case "model": {
        const rel = args?.path ?? args?.rel;
        if (!rel)
          throw new Error("模型节点缺少资产路径：用 path（或 rel）= 模型资产相对路径（.glb/.gltf）");
        node = engine().addModel(String(rel), parentId, asPosition(args?.position));
        break;
      }
      default:
        throw new Error(
          `未知节点类型: ${kind}（应为 group/mesh/light/camera/skybox/fog/audio/particle/terrain/nav/logic/script/model）`,
        );
    }
    // 显式命名：仅在提供了非空 name 时重命名（未提供保持引擎默认名，与历史 UI 一致）
    const name = args?.name ? String(args.name).trim() : "";
    if (name && node.name !== name) graph().rename(node.id, name);
    return { id: node.id, name: node.name, type: kind };
  },
});

registerCommand({
  id: "node.rename",
  label: "重命名节点",
  group: "节点",
  expose: true,
  description: "重命名节点（id 缺省时重命名当前选中节点）",
  run: (_ctx, args: any) => {
    const name = String(args?.name ?? "").trim();
    if (!name) return { renamed: false };
    if (args?.id) {
      graph().rename(String(args.id), name);
    } else {
      engine().renameSelected(name);
    }
    return { renamed: true, name };
  },
});

registerCommand({
  id: "node.delete",
  label: "删除节点",
  group: "节点",
  expose: true,
  description: "删除节点（id/ids：节点 id 或 id 数组；根场景节点不可删除）",
  run: (_ctx, args: any) => {
    const raw = args?.ids ?? (args?.id ? [args.id] : []);
    const ids = (Array.isArray(raw) ? raw : [raw])
      .map((v: unknown) => String(v))
      .filter(Boolean);
    const root = graph().root;
    let targets = ids.filter((id) => {
      const n = graph().get(id);
      return !!n && n.id !== root?.id;
    });
    if (targets.length > 1) {
      // 剔除互为子孙的冗余项，只保留顶层，避免父删后子再删的重复
      targets = targets.filter(
        (tid) => !targets.some((other) => other !== tid && graph().isDescendant(other, tid)),
      );
    }
    if (!targets.length) {
      console.warn("根场景节点不可删除");
      return { deleted: [] };
    }
    engine().deleteNodes(targets);
    return { deleted: targets };
  },
});

registerCommand({
  id: "node.duplicate",
  label: "复制节点",
  group: "节点",
  expose: true,
  description: "复制节点子树（id/ids：节点 id 或 id 数组；缺省 = 当前选中节点；根场景节点不可复制；一次撤销）",
  canRun: (ctx) => {
    if (ctx.view !== "editor") return false;
    const s = editor();
    if (!s.state.mounted) return false;
    return !!s.state.selectedId;
  },
  run: (_ctx, args: any) => {
    const raw = args?.ids ?? (args?.id ? [args.id] : []);
    let ids = (Array.isArray(raw) ? raw : [raw])
      .map((v: unknown) => String(v))
      .filter(Boolean);
    // 缺省：复制当前选中节点（Ctrl+D 快捷键路径）
    if (!ids.length) {
      ids = [...engine().selectionIds];
    }
    const root = graph().root;
    let targets = ids.filter((id) => {
      const n = graph().get(id);
      return !!n && n.id !== root?.id;
    });
    if (targets.length > 1) {
      // 剔除互为子孙的冗余项，只保留顶层，避免父复制后子再复制的重复
      targets = targets.filter(
        (tid) => !targets.some((other) => other !== tid && graph().isDescendant(other, tid)),
      );
    }
    if (!targets.length) {
      console.warn("根场景节点不可复制");
      return { duplicated: [] };
    }
    const newIds: string[] = [];
    for (const id of targets) {
      const newId = engine().duplicateNode(id);
      if (newId) newIds.push(newId);
    }
    if (newIds.length) engine().setSelection(newIds);
    return { duplicated: newIds };
  },
});

registerCommand({
  id: "node.reparent",
  label: "移动节点",
  group: "节点",
  description: "移动节点到新父级/新位置（moves：MoveTarget[]；selectIds 移动后选中）",
  run: (_ctx, args: any) => {
    const moves: MoveTarget[] = Array.isArray(args?.moves) ? args.moves : [];
    const valid: MoveTarget[] = [];
    for (const m of moves) {
      const n = graph().get(m.id);
      if (!n || n.isRoot) continue;
      // 成环：新父是被拖节点自身或其子孙（拖入自身子树）
      if (m.newParentId === m.id || (m.newParentId && graph().isDescendant(m.id, m.newParentId))) {
        console.warn("无法移动：不能拖入自身或其子孙节点");
        return { reparented: [] };
      }
      valid.push(m);
    }
    if (valid.length) {
      engine().reparentNodes(valid);
      const sel = Array.isArray(args?.selectIds) ? args.selectIds : [];
      if (sel.length) engine().setSelection(sel.map(String));
    }
    return { reparented: valid.map((m) => m.id) };
  },
});

registerCommand({
  id: "node.patch",
  label: "更新节点",
  group: "节点",
  description: "整节点属性补丁（before/after 快照，一次撤销）",
  run: (_ctx, args: any) => {
    const id = String(args?.id ?? "");
    if (!id || !graph().has(id)) return { patched: false };
    engine().patchNode(id, args.before as JsonRecord, args.after as JsonRecord, args.label);
    return { patched: true };
  },
});

registerCommand({
  id: "node.setTransform",
  label: "设置变换",
  group: "节点",
  description: "写入节点变换快照（position/rotation/scale，一次撤销）",
  run: (_ctx, args: any) => {
    const id = String(args?.id ?? "");
    if (id) engine().setTransform(id, args.snapshot);
    return { ok: true };
  },
});

registerCommand({
  id: "node.set",
  label: "设置节点属性",
  group: "节点",
  expose: true,
  description:
    "设置节点属性（写入节点 JSON 并走撤销历史）。两种形式：{id, prop, value} 单属性，" +
    "或 {id, ...字段} 字段包（name/visible/active/tag/transform/position/rotation/scale 等" +
    "任意混写；transform 与分量支持部分字段逐轴合并，未给的分量保持原值）",
  run: (_ctx, args: any) => {
    const id = String(args?.id ?? "");
    const node = graph().get(id);
    if (!node) throw new Error(`未找到节点: ${id}`);
    const parsed = parseNodeSetArgs(args);
    if ("error" in parsed) throw new Error(parsed.error);
    const { name, transform, props } = parsed.patch;
    const set: string[] = [];
    if (name !== undefined) {
      if (node.name !== name) graph().rename(id, name);
      set.push("name");
    }
    if (transform) {
      const merged = mergeTransformSnapshot(
        currentTransform(node.transform.position, node.transform.rotation, node.transform.scale),
        transform,
      );
      if ("error" in merged) throw new Error(merged.error);
      engine().setTransform(id, merged.snapshot);
      set.push("transform");
    }
    if (props) {
      const before = node.toJSON() as JsonRecord;
      const after = {
        ...(before as unknown as Record<string, unknown>),
        ...props,
      } as unknown as JsonRecord;
      engine().patchNode(id, before, after, "开发者服务·设置节点");
      set.push(...Object.keys(props));
    }
    return { ok: true, id, set };
  },
});

registerCommand({
  id: "node.alignCameraToViewport",
  label: "相机对齐当前视口",
  group: "节点",
  description: "把相机节点位姿与取景参数对齐到当前编辑器视口相机（id 缺省 = 当前选中节点；一次撤销）",
  run: (_ctx, args: any) => {
    const st = editor();
    if (!st.state.mounted) throw new Error("编辑器未就绪，无法对齐相机");
    const id = args?.id ? String(args.id) : st.state.selectedId;
    if (!id) return { aligned: false };
    const aligned = engine().alignCameraToViewport(id);
    if (!aligned) console.warn("对齐失败：目标不是相机节点");
    return { aligned, id };
  },
});

registerCommand({
  id: "node.select",
  label: "选中节点",
  group: "节点",
  expose: true,
  description: "选中场景节点（id 传空 = 取消选中）",
  run: (_ctx, args: any) => {
    engine().select(args?.id ? String(args.id) : null);
    return { ok: true };
  },
});

registerCommand({
  id: "node.renameSelected",
  label: "重命名选中节点",
  group: "节点",
  description: "弹出统一输入框重命名当前选中节点（层级右键/F2 共用；根节点不可重命名）",
  canRun: (ctx) => {
    if (ctx.view !== "editor") return false;
    const s = getEditorStore();
    if (!s.state.mounted) return false;
    if (!s.state.selectedId) return false;
    // 脚本工作台：正在文本编辑（Monaco 等）时不劫持 F2（保留编辑器自身重命名等行为）
    if (s.state.viewMode === "script" && isEditingText()) return false;
    return true;
  },
  run: async () => {
    const store = getEditorStore();
    if (!store.state.mounted) return { renamed: false };
    const id = store.state.selectedId;
    if (!id) return { renamed: false };
    const node = graph().get(id);
    if (!node || node.isRoot) return { renamed: false };
    const current = node.name;
    const name = await prompt({
      title: "重命名节点",
      label: current,
      initial: current,
      confirmText: "重命名",
    });
    if (name && name.trim()) {
      graph().rename(id, name.trim());
      return { renamed: true, name: name.trim() };
    }
    return { renamed: false };
  },
});
