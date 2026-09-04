export {
  docks,
  ALL_PANELS,
  ALL_ZONES,
  DOCK_PANEL_LABEL,
  panelZone,
  activate,
  removePanel,
  dockTo,
  floatPanel,
  closeFloating,
  type DockPanelId,
  type DockZoneId,
  type FloatingDock,
  type DockLayout,
} from "./docks-layout";

export { dockDnd, beginTabDrag, registerZoneEl, type DockDropTarget } from "./docks-dnd";

export { beginZoneResize } from "./docks-resize";