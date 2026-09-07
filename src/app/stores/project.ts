import { reactive } from "vue";
import { api, type RecentProject } from "../../lib/api";
import {
  DEFAULT_PHYSICS_BACKEND,
  isPhysicsBackendId,
  type PhysicsBackendId,
} from "../../framework/physics";

/** 项目默认主场景（打开项目时加载；之后可双击任意 .scene 资产切换） */
export const DEFAULT_SCENE_REL = "assets/Main.scene";

export type { RecentProject };

/** 编辑器渲染后端偏好（来自项目设置） */
export type RendererBackend = "webgl" | "webgpu" | "auto";

export interface ProjectStore {
  recent: RecentProject[];
  view: "home" | "editor";
  loading: boolean;
  /** 当前打开场景的相对路径（默认 assets/Main.scene；双击 .scene 资产切换） */
  sceneRel: string;
  /** 当前打开项目的根路径（资产扫描用） */
  currentPath: string | null;
  /** 当前打开项目名称 */
  projectName: string | null;
  /** 项目设置面板是否打开 */
  settingsOpen: boolean;
  /** 构建导出面板是否打开 */
  buildOpen: boolean;
  /** 编辑器渲染后端（读取项目 project.config.json 的 renderer 字段） */
  rendererBackend: RendererBackend;
  /** 编辑器抗锯齿（MSAA 采样数：0=无，2/4/8；读取项目配置） */
  antiAliasing: number;
  /** 渲染合成：hdr = HDR（ACES 色调映射）/ ldr = LDR（常规输出） */
  hdrMode: "hdr" | "ldr";
  /** 物理引擎后端（项目级；ammo | jolt | rapier） */
  physicsBackend: PhysicsBackendId;
  /** 是否启用物理模拟（项目级；预览/发布产物据此自动模拟） */
  physicsEnabled: boolean;
  /** 重力向量（项目级） */
  physicsGravity: { x: number; y: number; z: number };
  /** 项目设计分辨率（project.config.json designResolution；相机辅助视锥取景用） */
  designWidth: number;
  designHeight: number;
  setRendererBackend: (v: RendererBackend) => void;
  setPhysicsBackend: (v: PhysicsBackendId) => void;
  setPhysicsEnabled: (v: boolean) => void;
  setPhysicsGravity: (v: { x: number; y: number; z: number }) => void;
  setAntiAliasing: (v: number) => void;
  setHDRMode: (v: "hdr" | "ldr") => void;
  setDesignSize: (width: number, height: number) => void;
  setView: (view: "home" | "editor") => void;
  /**
   * 首页窗口打开/新建项目后由编辑器窗口调用：仅同步本地状态与渲染配置，
   * 不重复后端流程（open_project / 项目根 / 场景会话已在首页窗口侧就绪）。
   */
  applyOpenedProject: (root: string, name: string, rel: string) => void;
  setProjectName: (name: string | null) => void;
  /** 场景资产被移动/重命名后改写当前打开场景指针（保存仍写到新路径） */
  setSceneRel: (rel: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openBuild: () => void;
  closeBuild: () => void;
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
  loadScene: (path: string, rel?: string) => Promise<void>;
  /** 打开（切换）项目内任意 .scene 资产：加载文本 + 重载编辑器引擎场景 */
  openScene: (rel: string) => Promise<boolean>;
}

let singleton: ProjectStore | null = null;

/** 最近项目路径的比较键（分隔符/结尾分隔符/大小写不敏感；与后端 normalize 规则对应） */
function recentPathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getProjectStore(): ProjectStore {
  if (singleton) return singleton;

  const state = reactive({
    recent: [] as RecentProject[],
    // 编辑器窗口（main）常驻编辑器视图；首页由独立窗口（home）承担
    view: "editor" as "home" | "editor",
    loading: false,
    currentSceneRel: DEFAULT_SCENE_REL as string,
    currentPath: null as string | null,
    projectName: null as string | null,
    settingsOpen: false,
    buildOpen: false,
    rendererBackend: "webgl" as RendererBackend,
    antiAliasing: 2,
    hdrMode: "ldr" as "hdr" | "ldr",
    physicsBackend: DEFAULT_PHYSICS_BACKEND as PhysicsBackendId,
    physicsEnabled: false,
    physicsGravity: { x: 0, y: -9.81, z: 0 },
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
      const pb = (cfg.physics ?? {}) as { backend?: unknown; physicsEnabled?: unknown; gravity?: Record<string, unknown> };
      state.physicsBackend = isPhysicsBackendId(pb.backend) ? pb.backend : DEFAULT_PHYSICS_BACKEND;
      state.physicsEnabled = pb.physicsEnabled === true;
      const pg = (pb.gravity ?? {}) as { x?: unknown; y?: unknown; z?: unknown };
      const pn = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
      state.physicsGravity = {
        x: pn(pg.x, 0),
        y: pn(pg.y, -9.81),
        z: pn(pg.z, 0),
      };
      const dr = (cfg.designResolution ?? {}) as { width?: unknown; height?: unknown };
      const dw = typeof dr.width === "number" ? Math.round(dr.width) : 0;
      const dh = typeof dr.height === "number" ? Math.round(dr.height) : 0;
      state.designWidth = dw > 0 ? dw : 1280;
      state.designHeight = dh > 0 ? dh : 720;
    } catch {
      state.rendererBackend = "webgl";
      state.antiAliasing = 2;
      state.hdrMode = "ldr";
      state.physicsBackend = DEFAULT_PHYSICS_BACKEND;
      state.physicsEnabled = false;
      state.physicsGravity = { x: 0, y: -9.81, z: 0 };
      state.designWidth = 1280;
      state.designHeight = 720;
    }
  }

  /** 读取 project.config.json 中配置的主场景（缺失/损坏/指向非法路径时返回空串） */
  async function readConfiguredMainScene(root: string): Promise<string> {
    try {
      const cfg = JSON.parse(await api.readText(root, "project.config.json")) as Record<
        string,
        unknown
      >;
      const rel = cfg.mainScene;
      if (typeof rel !== "string" || !rel.trim()) return "";
      if (rel.startsWith("internal/") || rel === "src" || rel.startsWith("src/")) return "";
      return rel.trim();
    } catch {
      return "";
    }
  }

  /** 探测项目内文件当前是否可读（候选场景存在性检查） */
  async function isReadable(root: string, rel: string): Promise<boolean> {
    try {
      await api.readText(root, rel);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析打开/新建项目时要加载的场景：
   * 1. project.config.json 的 mainScene（文件仍存在时优先）；
   * 2. 默认 assets/Main.scene；
   * 3. 资产扫描到的第一个 .scene（主场景被移动/重命名后仍能找回，避免保存时在旧路径重建）。
   * 全部不存在时返回默认路径：保持旧行为，首次保存时创建项目的第一个场景。
   */
  async function resolveInitialSceneRel(root: string): Promise<string> {
    const candidates = [await readConfiguredMainScene(root), DEFAULT_SCENE_REL];
    try {
      const scenes = await api.scanAssets(root);
      candidates.push(
        ...scenes
          .filter(
            (a) =>
              a.kind === "scene" &&
              !a.path.endsWith("/") &&
              a.path !== "src" &&
              !a.path.startsWith("src/"),
          )
          .map((a) => a.path)
          .sort(),
      );
    } catch {
      /* 扫描失败时仅尝试已配置/默认候选 */
    }
    for (const rel of [...new Set(candidates)]) {
      if (rel && (await isReadable(root, rel))) return rel;
    }
    return DEFAULT_SCENE_REL;
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
    get sceneRel() {
      return state.currentSceneRel;
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
    get buildOpen() {
      return state.buildOpen;
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
    get physicsBackend() {
      return state.physicsBackend;
    },
    get physicsEnabled() {
      return state.physicsEnabled;
    },
    get physicsGravity() {
      return state.physicsGravity;
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
    setPhysicsBackend(v) {
      state.physicsBackend = v;
    },
    setPhysicsEnabled(v) {
      state.physicsEnabled = v;
    },
    setPhysicsGravity(v) {
      state.physicsGravity = { ...v };
    },
    setDesignSize(width, height) {
      state.designWidth = Math.max(1, Math.min(16384, Math.round(width)));
      state.designHeight = Math.max(1, Math.min(16384, Math.round(height)));
    },
    setView(view) {
      state.view = view;
    },
    applyOpenedProject(root, name, rel) {
      state.currentPath = root;
      state.projectName = name;
      state.currentSceneRel = rel;
      state.settingsOpen = false;
      state.view = "editor";
      void loadProjectRenderConfig(root);
    },
    setProjectName(name) {
      state.projectName = name;
    },
    setSceneRel(rel) {
      state.currentSceneRel = rel;
    },
    openSettings() {
      if (!state.currentPath || state.view !== "editor") return;
      state.settingsOpen = true;
    },
    closeSettings() {
      state.settingsOpen = false;
    },
    openBuild() {
      if (!state.currentPath || state.view !== "editor") return;
      state.buildOpen = true;
    },
    closeBuild() {
      state.buildOpen = false;
    },
    addRecent(project) {
      const key = recentPathKey(project.path);
      state.recent = [
        project,
        ...state.recent.filter((p) => recentPathKey(p.path) !== key),
      ].slice(0, 20);
    },
    removeRecent(path) {
      const key = recentPathKey(path);
      state.recent = state.recent.filter((p) => recentPathKey(p.path) !== key);
    },
    clearRecent() {
      state.recent = [];
    },
    async refreshRecent() {
      state.loading = true;
      try {
        const projects = await api.listRecentProjects();
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
        const info = await api.openProject(path);
        // asset:// 协议的项目根必须先于任何资产请求就位（模型/贴图直读依赖）
        await api.setCurrentProjectRoot(info.path);
        await store.loadScene(info.path, await resolveInitialSceneRel(info.path));
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
        const info = await api.createProject(parent, name, templateId, files);
        await api.setCurrentProjectRoot(info.path);
        await store.loadScene(info.path, await resolveInitialSceneRel(info.path));
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
        const path = await api.pickProjectFolder();
        return path;
      } catch (e) {
        console.error("Failed to pick folder:", e);
        return null;
      }
    },
    async loadScene(_path, rel = DEFAULT_SCENE_REL) {
      // 场景内容由后端会话持有（scene_open 读盘/迁移/建图）；这里只记录当前场景指针
      state.currentSceneRel = rel;
    },
    async openScene(rel) {
      const root = state.currentPath;
      if (!root) return false;
      if (rel.startsWith("internal/") || rel === "src" || rel.startsWith("src/")) {
        console.warn("不能打开内置/脚本路径作为场景:", rel);
        return false;
      }
      state.currentSceneRel = rel;
      // 编辑器已挂载：后端重装会话 + 镜像重建（层级/视口切换），无需重进编辑器
      if (state.view === "editor") {
        const { reloadEditorScene } = await import("../services/editorService");
        await reloadEditorScene(root, rel);
      }
      return true;
    },
  };

  singleton = store;
  return store;
}
