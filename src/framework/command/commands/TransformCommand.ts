import type { SceneGraph } from "../../scene/SceneGraph";
import type { Node } from "../../prototype/Node";
import type { Vec3 } from "../../prototype/types";
import type { Command } from "../Command";

export interface TransformSnapshot {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function snapTransform(node: Node): TransformSnapshot {
  return {
    position: { ...node.transform.position },
    rotation: { ...node.transform.rotation },
    scale: { ...node.transform.scale },
  };
}

export class TransformCommand implements Command {
  readonly label = "Set Transform";
  private before: TransformSnapshot;
  private after: TransformSnapshot;
  constructor(
    private graph: SceneGraph,
    private nodeId: string,
    target: TransformSnapshot,
  ) {
    const node = this.graph.get(nodeId);
    this.before = node ? snapTransform(node) : { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    this.after = target;
  }

  setBefore(from: TransformSnapshot): void {
    this.before = from;
  }

  execute(): void {
    this.apply(this.after);
  }
  undo(): void {
    this.apply(this.before);
  }

  private apply(snap: TransformSnapshot): void {
    const node = this.graph.get(this.nodeId);
    if (!node) return;
    node.transform.setPosition(snap.position.x, snap.position.y, snap.position.z);
    node.transform.setRotation(snap.rotation.x, snap.rotation.y, snap.rotation.z);
    node.transform.setScale(snap.scale.x, snap.scale.y, snap.scale.z);
    this.graph.patchTransform(this.nodeId);
  }
}