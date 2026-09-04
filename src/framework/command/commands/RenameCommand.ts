import type { SceneGraph } from "../../scene/SceneGraph";
import type { Command } from "../Command";

export class RenameCommand implements Command {
  readonly label: string;
  private oldName = "";
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    private newName: string,
    label?: string,
  ) {
    this.label = label ?? `Rename node`;
    this.oldName = this.graph.get(nodeId)?.name ?? "";
  }
  execute(): void {
    this.graph.rename(this.nodeId, this.newName);
  }
  undo(): void {
    this.graph.rename(this.nodeId, this.oldName);
  }
}