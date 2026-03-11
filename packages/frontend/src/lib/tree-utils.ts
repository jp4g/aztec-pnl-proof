import type { TreeNode, TreeNodeStatus } from "@/types";

/**
 * Build tree visualization nodes for an arbitrary number of leaves.
 * Returns `treeLevels` bottom-up: [leaves, ...intermediates, root].
 *
 * @param totalLeaves - number of real swap leaves
 * @param provenCount - how many leaf proofs are done
 * @param currentProving - index of leaf currently being proven (null if not proving a leaf)
 * @param aggregation - aggregation progress:
 *   "complete": all intermediate levels verified
 *   number: how many viz levels are fully done (0 = none)
 *   object: granular per-node progress { level, nodeIndex }
 */
export function buildTreeNodes(
  totalLeaves: number,
  provenCount: number,
  currentProving: number | null,
  aggregation: number | { level: number; nodeIndex: number } | "complete" = 0,
): { treeLevels: TreeNode[][] } {
  if (totalLeaves === 0) return { treeLevels: [] };

  // Pad to next power of 2, min 2
  const padded = Math.max(2, Math.pow(2, Math.ceil(Math.log2(Math.max(totalLeaves, 1)))));
  const numIntermediateLevels = Math.log2(padded); // e.g. 8 leaves -> 3 levels above

  function intermediateStatus(vizLevel: number, nodeIndex: number, isUnused: boolean): TreeNodeStatus {
    if (isUnused) return "unused";
    if (aggregation === "complete") return "verified";
    if (typeof aggregation === "number") {
      return vizLevel < aggregation ? "verified" : "pending";
    }
    const { level: aggLevel, nodeIndex: aggNode } = aggregation;
    if (vizLevel < aggLevel) return "verified";
    if (vizLevel > aggLevel) return "pending";
    if (nodeIndex < aggNode) return "verified";
    if (nodeIndex === aggNode) return "proving";
    return "pending";
  }

  // Build leaves
  const leaves: TreeNode[] = [];
  for (let i = 0; i < padded; i++) {
    let status: TreeNodeStatus;
    if (i >= totalLeaves) status = "unused";
    else if (i < provenCount) status = "verified";
    else if (currentProving !== null && i === currentProving) status = "proving";
    else status = "pending";
    leaves.push({
      id: `leaf-${i}`,
      status,
      label: i < totalLeaves ? `Tx ${i + 1}` : "Pad",
    });
  }

  const levels: TreeNode[][] = [leaves];

  // Build intermediate levels (including root)
  for (let lvl = 0; lvl < numIntermediateLevels; lvl++) {
    const prev = levels[lvl];
    const count = prev.length / 2;
    const isRoot = lvl === numIntermediateLevels - 1;
    const nodes: TreeNode[] = [];
    for (let i = 0; i < count; i++) {
      const bothUnused =
        prev[i * 2].status === "unused" &&
        prev[i * 2 + 1].status === "unused";
      nodes.push({
        id: isRoot ? "root" : `int-${lvl}-${i}`,
        status: intermediateStatus(lvl, i, isRoot ? false : bothUnused),
        label: isRoot ? "Root" : undefined,
      });
    }
    levels.push(nodes);
  }

  return { treeLevels: levels };
}
