import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../lib/api";

export interface RecentProject {
  name: string;
  path: string;
  sceneCount: number;
}

/** 编辑器渲染后端偏好（来自项目设置） */
export type RendererBackend = "webgl" | "webgpu" | "auto";

export interface ProjectStore {
  recent: RecentProject[];
  view: "home" | "editor";
  loading: boolean;
  /** 当前打开项目的主场景 JSON 文本（进入编辑器时加载） */
  sceneJson: string | null;
  /** 当前打开项目的根路径（资产扫描用） */
  currentPath: string | null;
  /** 当前打开项目名称 */
  projectName: string | null;
  /** 项目设置面板是否打开 */
  settingsOpen: boolean;
  /** 编辑器渲染后端（读取项目 project.config.json 的 renderer 字段） */
  rendererBackend: RendererBackend;
  /** 编辑器抗锯齿（MSAA 采样数：0=无，2/4/8；读取项目配置） */
  antiAliasing: number;
  /** 渲染合成：hdr = HDR（ACES 色调映射）/ ldr = LDR（常规输出） */
  hdrMode: "hdr" | "ldr";
  /** 项目设计分辨率（project.config.json designResolution；相机辅助视锥取景用） */
  designWidth: number;
  designHeight: number;
  setRendererBackend: (v: RendererBackend) => void;
  setAntiAliasing: (v: number) => void;
  setHDRMode: (v: "hdr" | "ldr") => void;
  setDesignSize: (width: number, height: number) => void;
  setView: (view: "home" | "editor") => void;
  setProjectName: (name: string | null) => void;
  openSettings: () => void;
  closeSettings: () => void;
  addRecent: (project: RecentProject) => void;
  removeRecent: (path: string) => void;
  clearRecent: () => void;
  refreshRecent: () => Promise<void>;
  openProject: (path: string) => Promise<boolean>;
  createProject: (
    parent: string,
    name: string,
    templateId: string,
    files: Record<string, string>,
  ) => Promise<RecentProject | null>;
  pickFolder: () => Promise<string | null>;
  loadScene: (path: string) => Promise<void>;
}

let singleton: ProjectStore | null = null;

export function getProjectStore(): ProjectStore {
  if (singleton) return singleton;

  const state = reactive({
    recent: [] as RecentProject[],
    view: "home" as "home" | "editor",
    loading: false,
    sceneJson: null as string | null,
    currentPath: null as string | null,
    projectName: null as string | null,
    settingsOpen: false,
    rendererBackend: "webgl" as RendererBackend,
    antiAliasing: 2,
    hdrMode: "ldr" as "hdr" | "ldr",
    designWidth: 1280,
    designHeight: 720,
  });

  /** 读取项目 project.config.json 中的渲染后端/抗锯齿/HDR/设计分辨率偏好（缺失/损坏回退默认） */
  async function loadProjectRenderConfig(root: string): Promise<void> {
    try {
      const text = await api.readText(root, "project.config.json");
      const cfg = JSON.parse(text) as Record<string, unknown>;
      const r = cfg.renderer;
      state.rendererBackend = r === "webgpu" || r === "auto" || r === "webgl" ? r : "webgl";
      const aa = cfg.antiAliasing;
      state.antiAliasing =
        typeof aa === "number" ? Math.max(0, Math.min(8, Math.round(aa))) : 2;
      state.hdrMode = cfg.hdrMode === "hdr" ? "hdr" : "ldr";
      const dr = (cfg.designResolution ?? {}) as { width?: unknown; height?: unknown };
      const dw = typeof dr.width === "number" ? Math.round(dr.width) : 0;
      const dh = typeof dr.height === "number" ? Math.round(dr.height) : 0;
      state.designWidth = dw > 0 ? dw : 1280;
      state.designHeight = dh > 0 ? dh : 720;
    } catch {
      state.rendererBackend = "webgl";
      state.antiAliasing = 2;
      state.hdrMode = "ldr";
      state.designWidth = 1280;
      state.designHeight = 720;
    }
  }

  const store: ProjectStore = {
    get recent() {
      return state.recent;
    },
    get view() {
      return state.view;
    },
    get loading() {
      return state.loading;
    },
    get sceneJson() {
      return state.sceneJson;
    },
    get currentPath() {
      return state.currentPath;
    },
    get projectName() {
      return state.projectName;
    },
    get settingsOpen() {
      return state.settingsOpen;
    },
    get rendererBackend() {
      return state.rendererBackend;
    },
    get antiAliasing() {
      return state.antiAliasing;
    },
    get hdrMode() {
      return state.hdrMode;
    },
    get designWidth() {
      return state.designWidth;
    },
    get designHeight() {
      return state.designHeight;
    },
    setRendererBackend(v) {
      state.rendererBackend = v;
    },
    setAntiAliasing(v) {
      state.antiAliasing = v;
    },
    setHDRMode(v) {
      state.hdrMode = v;
    },
    setDesignSize(width, height) {
      state.designWidth = Math.max(1, Math.min(16384, Math.round(width)));
      state.designHeight = Math.max(1, Math.min(16384, Math.round(height)));
    },
    setView(view) {
      state.view = view;
    },
    setProjectName(name) {
      state.projectName = name;
    },
    openSettings() {
      if (!state.currentPath || state.view !== "editor") return;
      state.settingsOpen = true;
    },
    closeSettings() {
      state.settingsOpen = false;
    },
    addRecent(project) {
      state.recent = [
        project,
        ...state.recent.filter((p) => p.path !== project.path),
      ].slice(0, 20);
    },
    removeRecent(path) {
      state.recent = state.recent.filter((p) => p.path !== path);
    },
    clearRecent() {
      state.recent = [];
    },
    async refreshRecent() {
      state.loading = true;
      try {
        const projects = await invoke<RecentProject[]>("list_recent_projects");
        state.recent = projects;
      } catch (e) {
        console.error("Failed to load recent projects:", e);
      } finally {
        state.loading = false;
      }
    },
    async openProject(path) {
      state.loading = true;
      try {
        const info = await invoke<RecentProject>("open_project", { path });
        await store.loadScene(info.path);
        await loadProjectRenderConfig(info.path);
        state.currentPath = info.path;
        store.setProjectName(info.name);
        store.addRecent(info);
        state.settingsOpen = false;
        state.view = "editor";
        return true;
      } catch (e) {
        console.error("Failed to open project:", e);
        return false;
      } finally {
        state.loading = false;
      }
    },
    async createProject(parent, name, templateId, files) {
      state.loading = true;
      try {
        const info = await invoke<RecentProject>("create_project", {
          parent,
          name,
          templateId,
          files,
        });
        await store.loadScene(info.path);
        await loadProjectRenderConfig(info.path);
        state.currentPath = info.path;
        store.setProjectName(info.name);
        store.addRecent(info);
        state.settingsOpen = false;
        state.view = "editor";
        return info;
      } catch (e) {
        console.error("Failed to create project:", e);
        return null;
      } finally {
        state.loading = false;
      }
    },
    async pickFolder() {
      try {
        const path = await invoke<string | null>("pick_project_folder");
        return path;
      } catch (e) {
        console.error("Failed to pick folder:", e);
        return null;
      }
    },
    async loadScene(path) {
      try {
        state.sceneJson = await invoke<string>("read_project_scene", { path });
      } catch (e) {
        console.error("Failed to read project scene:", e);
        state.sceneJson = null;
      }
    },
  };

  singleton = store;
  return store;
}
