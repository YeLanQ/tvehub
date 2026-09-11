// 场景节点编辑命令：层级面板/视口/属性面板的写操作与 devtools 共用同一执行路径。
// 写仍由 engine 执行（乐观应用 → 后端提交 → 撤销历史）；命令层只负责
// 类型解析（geometry/light/skybox/脚本节点）、命名与 guard（根节点/成环/子孙去重）。

import { getEditorStore } from "../stores/editor";
import { getProjectStore } from "../stores/project";
import { getScriptsStore } from "../stores/scripts";
import { prompt } from "../lib/prompt";
import { registerCommand } from "./registry";
import { isEditingText } from "./context";
import type { MoveTarget } from "../../framework/scene/SceneClient";
import type { JsonRecord } from "../../framework/prototype/types";
import { parseUIScaleMode } from "../../framework/prototype/nodes/ui-shared";
import type { GeometryKind } from "../../framework/mesh/geometry";
import type { LightKind } from "../../framework/prototype/nodes/LightNode";
import type { SkyboxKind } from "../../framework/prototype/nodes/SkyboxNode";

const GEOMETRY_KINDS: GeometryKind[] = [
  "box", "sphere", "plane", "cylinder", "cone", "torus", "capsule",
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

registerCommand({
  id: "node.add",
  label: "添加节点",
  group: "节点",
  expose: true,
  description:
    "在指定父节点下新增节点（kind: group/mesh/light/camera/skybox/audio/particle/script/model；mesh 可带 subtype 几何，light 可带 subtype 灯光，skybox 可带 subtype 天空，script 可带 subtype 脚本 rel，model/audio 需 path 资产路径）",
  run: (_ctx, args: any) => {
    const st = editor();
    if (!st.state.mounted) throw new Error("编辑器未就绪，无法添加节点");
    const parentId = args?.parentId ? String(args.parentId) : undefined;
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
      case "audio":
      case "audionode": {
        // 可选 path：直接绑定音频资产（资产面板「添加到场景」）
        const audioPath = args?.path !== undefined ? String(args.path) : "";
        node = engine().addAudio(parentId, audioPath);
        break;
      }
      case "particle":
      case "particles":
      case "particlesystem":
      case "particlesystemnode":
        node = engine().addParticleSystem(parentId);
        break;
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
            // 画布渲染尺寸默认取项目设置（设计分辨率按屏幕方向定向 + 缩放模式）
            const ps = getProjectStore();
            let w = Math.max(1, Math.round(ps.designWidth));
            let h = Math.max(1, Math.round(ps.designHeight));
            if (ps.orientation === "portrait" && w > h) [w, h] = [h, w];
            if (ps.orientation === "landscape" && h > w) [w, h] = [h, w];
            node = engine().addUICanvas(parentId, {
              designWidth: w,
              designHeight: h,
              scaleMode: parseUIScaleMode(ps.scaleMode),
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
        const rel = subtype ?? args?.scriptRel;
        if (!rel) throw new Error("脚本节点缺少 rel（脚本路径）");
        const nt = getScriptsStore().scriptNodeTypes().find((s) => s.rel === rel);
        node = engine().addScriptNode(String(rel), nt?.nodeType ?? { kind: "node" }, parentId);
        break;
      }
      case "model": {
        const rel = args?.path;
        if (!rel) throw new Error("模型节点缺少 path（模型资产相对路径）");
        node = engine().addModel(String(rel), parentId);
        break;
      }
      default:
        throw new Error(
          `未知节点类型: ${kind}（应为 group/mesh/light/camera/skybox/audio/particle/script/model）`,
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
  description: "设置节点属性（写入节点 JSON 并走撤销历史）",
  run: (_ctx, args: any) => {
    const id = String(args?.id ?? "");
    const node = graph().get(id);
    if (!node) throw new Error(`未找到节点: ${id}`);
    const prop = String(args?.prop ?? "");
    if (!prop || prop === "id" || prop === "childIds" || prop === "parentId") {
      throw new Error(`不支持设置的属性: ${prop || "(空)"}`);
    }
    if (prop === "name") {
      graph().rename(id, String(args?.value ?? ""));
      return { ok: true, id, prop, value: args?.value };
    }
    const before = node.toJSON() as JsonRecord;
    const after = {
      ...(before as unknown as Record<string, unknown>),
      [prop]: args?.value,
    } as unknown as JsonRecord;
    engine().patchNode(id, before, after, "开发者服务·设置节点");
    return { ok: true, id, prop, value: args?.value };
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
