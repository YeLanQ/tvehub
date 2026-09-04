import type { SceneGraph } from "../../scene/SceneGraph";
import type { Command } from "../Command";

export class ReparentCommand implements Command {
  readonly label: string;
  private oldParentId: string | null = null;
  private oldIndex = -1;
  private newParentId: string | null = null;
  private newIndex = -1;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    newParentId: string | null,
    newIndex = -1,
    label?: string,
  ) {
    this.label = label ?? `Reparent node`;
    this.newParentId = newParentId;
    this.newIndex = newIndex;
    const node = this.graph.get(nodeId);
    this.oldParentId = node?.parentId ?? null;
    const parent = this.oldParentId ? this.graph.get(this.oldParentId) : undefined;
    this.oldIndex = parent ? parent.childIds.indexOf(nodeId) : 0;
  }
  execute(): void {
    this.graph.reparent(this.nodeId, this.newParentId, this.newIndex);
  }
  undo(): void {
    this.graph.reparent(this.nodeId, this.oldParentId, this.oldIndex);
  }
}