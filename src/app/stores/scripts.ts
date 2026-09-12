// ---------------------------------------------------------------------------
// 脚本 store（脚本模式工作台的状态中枢）：
// - 文件缓存（源码 + 脏标记 + props 声明 + 编译诊断）与打开标签页管理；
//   工作台同时承载 ts 脚本与 .shader 着色器资产（后者保存走 shader_write_source
//   解析组装 + 引擎缓存刷新，无 TS 编译）；
// - 保存 = 写盘 + 内存编译（诊断反馈）+ props 声明解析（检查器控件刷新）；
// - 新建/重命名/删除脚本（经 assets store 落盘），并把场景内组件引用同步改写/
//   移除（engine.patchNode，可撤销）。
// Monaco 模型由脚本编辑器面板（monaco-setup）挂接本 store 的数据，不在此持有。
// ---------------------------------------------------------------------------

import { reactive } from "vue";
import { api } from "../../lib/api";
import { getAssetsStore } from "./assets";
import type { ScriptPrototype } from "../lib/script-prototypes";
import { getProjectStore } from "./project";
import { getEditorStore } from "./editor";
import { logStore } from "./log";
import {
  compileScript,
  isScriptSource,
  parseScriptClassMeta,
  type ScriptPropDef,
  type ScriptNodeType,
} from "../lib/script-compile";
import { saveShaderSource } from "../lib/shaders";
import type { JsonRecord } from "../../framework/prototype/types";

/** 工作台标签页文件类别：ts 脚本（保存 = 编译）/ .shader 着色器（保存 = 解析组装） */
type WorkbenchFileKind = "script" | "shader";

export function isShaderSource(rel: string): boolean {
  return rel.endsWith(".shader");
}

interface ScriptFileState {
  /** 文件类别（打开时按扩展名判定） */
  kind: WorkbenchFileKind;
  /** 磁盘上的源码（保存后更新） */
  source: string;
  dirty: boolean;
  /** 编译/解析诊断（保存时刷新；null = 无错误。着色器 = 解析错误） */
  compileError: string | null;
  /** props 声明（null = 未声明/无法解析；着色器恒 null） */
  propsSchema: ScriptPropDef[] | null;
  /** 节点类型声明（static nodeType；null = 普通脚本组件） */
  nodeType: ScriptNodeType | null;
}

export interface ScriptsStore {
  readonly tabs: string[];
  readonly active: string | null;
  readonly busy: boolean;
  /** 脚本属性 schema 版本号：保存脚本成功后递增（检查器据此刷新属性控件） */
  readonly schemaRev: number;
  fileState(rel: string): ScriptFileState | undefined;
  isDirty(rel: string): boolean;
  openScript(rel: string): Promise<void>;
  closeTab(rel: string): void;
  setActive(rel: string): void;
  setContent(rel: string, text: string): void;
  saveScript(rel: string): Promise<boolean>;
  saveAll(): Promise<boolean>;
  createScript(name: string, proto?: ScriptPrototype): Promise<string | null>;
  renameScript(rel: string, newName: string): Promise<string | null>;
  deleteScript(rel: string): Promise<boolean>;
  /** 检查器用：按需读取并解析脚本 props 声明（缓存） */
  propsSchemaFor(rel: string): Promise<ScriptPropDef[] | null>;
  /** 节点类型清单：声明了 static nodeType/@nodeType 的脚本（层级/资源面板创建入口数据） */
  scriptNodeTypes(): { rel: string; name: string; nodeType: ScriptNodeType }[];
  /** 预读全部 src/ 脚本并解析元数据（面板挂载时预热 nodeType/props 缓存） */
  prefetchScriptMetas(): Promise<void>;
  /** 项目脚本清单（assets 扫描结果的 src/**.ts） */
  listScripts(): string[];
}

let singleton: ScriptsStore | null = null;

export function getScriptsStore(): ScriptsStore {
  if (singleton) return singleton;

  const state = reactive({
    tabs: [] as string[],
    active: null as string | null,
    busy: false,
    schemaRev: 0,
    files: new Map<string, ScriptFileState>(),
  });

  async function ensureLoaded(rel: string): Promise<ScriptFileState | null> {
    const existing = state.files.get(rel);
    if (existing) return existing;
    const root = getProjectStore().currentPath;
    if (!root) return null;
    try {
      const source = await api.readText(root, rel);
      if (source == null) return null;
      const kind: WorkbenchFileKind = isShaderSource(rel) ? "shader" : "script";
      // 着色器不是 TS：跳过脚本元数据解析
      const meta = kind === "shader"
        ? { props: null as ScriptPropDef[] | null, nodeType: null as ScriptNodeType | null }
        : await parseScriptClassMeta(source).catch(() => ({
            props: null as ScriptPropDef[] | null,
            nodeType: null as ScriptNodeType | null,
          }));
      const st: ScriptFileState = {
        kind,
        source,
        dirty: false,
        compileError: null,
        propsSchema: meta.props,
        nodeType: meta.nodeType,
      };
      state.files.set(rel, st);
      return st;
    } catch (e) {
      logStore.log("error", `读取脚本失败 ${rel}: ${e}`, "script");
      return null;
    }
  }

  const store: ScriptsStore = {
    get tabs() {
      return state.tabs;
    },
    get active() {
      return state.active;
    },
    get busy() {
      return state.busy;
    },
    get schemaRev() {
      return state.schemaRev;
    },
    fileState(rel) {
      return state.files.get(rel);
    },
    isDirty(rel) {
      return state.files.get(rel)?.dirty === true;
    },
    async openScript(rel) {
      // 工作台可编辑：ts 脚本（src/ 内）与 .shader 着色器资产
      if (!isScriptSource(rel) && !isShaderSource(rel)) return;
      const st = await ensureLoaded(rel);
      if (!st) return;
      if (!state.tabs.includes(rel)) state.tabs.push(rel);
      state.active = rel;
    },
    closeTab(rel) {
      const i = state.tabs.indexOf(rel);
      if (i < 0) return;
      state.tabs.splice(i, 1);
      if (state.active === rel) {
        state.active = state.tabs[Math.min(i, state.tabs.length - 1)] ?? null;
      }
    },
    setActive(rel) {
      if (state.tabs.includes(rel)) state.active = rel;
    },
    setContent(rel, text) {
      const st = state.files.get(rel);
      if (!st || st.source === text) return;
      st.source = text;
      st.dirty = true;
    },
    async saveScript(rel) {
      const st = state.files.get(rel);
      const root = getProjectStore().currentPath;
      if (!st || !root) return false;
      state.busy = true;
      try {
        // 着色器：走 shader_write_source（指令跟随路径 + 解析校验 + 自动补 .meta），
        // 返回文档写引擎缓存（视口刷新 + 材质面板取新属性）；解析错误不阻断保存
        if (st.kind === "shader") {
          const doc = await saveShaderSource(root, rel, st.source);
          st.compileError = doc.error || null;
          st.dirty = false;
          // 写引擎着色器缓存：视口即刻按新源码重组程序，材质面板取新属性表
          getEditorStore().engine.shaders.cachePut(rel, doc);
          if (doc.error) {
            logStore.log("error", `着色器解析失败 ${rel}: ${doc.error}（材质按 Base 分支渲染）`, "script");
          } else {
            logStore.log("success", `已保存着色器 ${rel}（${doc.base} 分支 · ${doc.hooks.length} 个钩子）`, "script");
          }
          return !doc.error;
        }
        await api.writeText(root, rel, st.source);
        const [compiled, meta] = await Promise.all([
          compileScript(st.source, rel),
          parseScriptClassMeta(st.source).catch(() => ({
            props: null as ScriptPropDef[] | null,
            nodeType: null as ScriptNodeType | null,
          })),
        ]);
        st.compileError = compiled.error;
        st.propsSchema = meta.props;
        st.nodeType = meta.nodeType;
        st.dirty = false;
        // 保存成功 → bump schema 版本：检查器属性控件据此刷新
        state.schemaRev += 1;
        if (compiled.error) {
          logStore.log("error", `脚本编译失败 ${rel}: ${compiled.error}`, "script");
        }
        return !compiled.error;
      } catch (e) {
        logStore.log("error", `保存脚本失败 ${rel}: ${e}`, "script");
        return false;
      } finally {
        state.busy = false;
      }
    },
    async saveAll() {
      let ok = true;
      for (const rel of state.tabs) {
        if (state.files.get(rel)?.dirty) {
          if (!(await store.saveScript(rel))) ok = false;
        }
      }
      return ok;
    },
    async createScript(name, proto) {
      const root = getProjectStore().currentPath;
      if (!root) return null;
      const assetsStore = getAssetsStore();
      const rel = await assetsStore.createScriptAsset(root, "src", name, proto);
      if (rel) await store.openScript(rel);
      return rel;
    },
    async renameScript(rel, newName) {
      const root = getProjectStore().currentPath;
      if (!root) return null;
      const assetsStore = getAssetsStore();
      const toRel = await assetsStore.rename(root, rel, newName);
      if (!toRel) return null;
      // 标签页与缓存换键
      const st = state.files.get(rel);
      if (st) {
        state.files.delete(rel);
        state.files.set(toRel, st);
      }
      const i = state.tabs.indexOf(rel);
      if (i >= 0) state.tabs.splice(i, 1, toRel);
      if (state.active === rel) state.active = toRel;
      // 场景内组件引用同步改写
      rewriteScriptRefs(rel, toRel);
      return toRel;
    },
    async deleteScript(rel) {
      const root = getProjectStore().currentPath;
      if (!root) return false;
      const assetsStore = getAssetsStore();
      if (!(await assetsStore.remove(root, rel))) return false;
      state.files.delete(rel);
      store.closeTab(rel);
      // 场景内引用该脚本的组件一并移除（组件离开脚本无意义）
      removeScriptComponents(rel);
      return true;
    },
    async propsSchemaFor(rel) {
      const st = await ensureLoaded(rel);
      return st?.propsSchema ?? null;
    },
    scriptNodeTypes() {
      const out: { rel: string; name: string; nodeType: ScriptNodeType }[] = [];
      for (const rel of store.listScripts()) {
        const st = state.files.get(rel);
        if (!st?.nodeType) continue;
        out.push({
          rel,
          name: st.nodeType.label || rel.replace(/\.ts$/, "").split("/").pop() || "Node",
          nodeType: st.nodeType,
        });
      }
      return out;
    },
    async prefetchScriptMetas() {
      for (const rel of store.listScripts()) {
        if (state.files.has(rel)) continue;
        await ensureLoaded(rel);
      }
    },
    listScripts() {
      const assetsStore = getAssetsStore();
      return assetsStore.assets
        .map((a) => a.path)
        .filter(isScriptSource)
        .sort((a, b) => a.localeCompare(b));
    },
  };

  singleton = store;
  return store;
}

// ---------------------------------------------------------------------------
// 场景内脚本引用同步（重命名改写 / 删除移除；走 patchNode 可撤销）
// ---------------------------------------------------------------------------

/** 脚本重命名后改写场景节点 components[].script 引用 */
function rewriteScriptRefs(fromRel: string, toRel: string): void {
  const engine = getEditorStore().engine;
  for (const node of engine.graph.all()) {
    if (!node.components.some((c) => c.type === "script" && c.script === fromRel)) continue;
    const before = node.toJSON() as JsonRecord;
    node.components = node.components.map((c) =>
      c.type === "script" && c.script === fromRel ? { ...c, script: toRel } : c,
    );
    const after = node.toJSON() as JsonRecord;
    engine.patchNode(node.id, before, after, "重命名脚本引用");
  }
}

/** 脚本删除后移除场景节点上引用它的组件 */
function removeScriptComponents(rel: string): void {
  const engine = getEditorStore().engine;
  for (const node of engine.graph.all()) {
    if (!node.components.some((c) => c.type === "script" && c.script === rel)) continue;
    const before = node.toJSON() as JsonRecord;
    node.components = node.components.filter((c) => !(c.type === "script" && c.script === rel));
    const after = node.toJSON() as JsonRecord;
    engine.patchNode(node.id, before, after, "移除已删除脚本的组件");
  }
}
