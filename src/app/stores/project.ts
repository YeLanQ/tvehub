import { reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";

export interface RecentProject {
  name: string;
  path: string;
  sceneCount: number;
}

export interface ProjectStore {
  recent: RecentProject[];
  view: "home" | "editor";
  loading: boolean;
  /** 当前打开项目的主场景 JSON 文本（进入编辑器时加载） */
  sceneJson: string | null;
  /** 当前打开项目的根路径（资产扫描用） */
  currentPath: string | null;
  setView: (view: "home" | "editor") => void;
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
  });

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
    setView(view) {
      state.view = view;
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
        state.currentPath = info.path;
        store.addRecent(info);
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
        state.currentPath = info.path;
        store.addRecent(info);
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
