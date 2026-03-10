"use client";

import { Icon } from "@iconify/react";
import { TreeNode, TreeNodeStatus } from "@/types";

// --- Tree Node Components ---

type NodeSize = "lg" | "md" | "sm" | "xs";

function getNodeStyles(status: TreeNodeStatus, size: NodeSize) {
  const sizeClasses: Record<NodeSize, string> = {
    lg: "w-12 h-12",
    md: "w-10 h-10",
    sm: "w-8 h-8",
    xs: "w-6 h-6",
  };

  const base = sizeClasses[size];

  switch (status) {
    case "verified":
      return `${base} rounded-full bg-green-500 border-2 border-green-500 flex items-center justify-center text-white shadow-sm`;
    case "proving":
      return `${base} rounded-full bg-blue-500 border-2 border-blue-500 flex items-center justify-center text-white shadow-lg shadow-blue-200 animate-pulse`;
    case "pending":
      return `${base} rounded-full bg-white border-2 border-neutral-900 flex items-center justify-center shadow-sm`;
    case "unused":
      return `${base} rounded-full bg-neutral-100 border-2 border-neutral-200 flex items-center justify-center`;
  }
}

const ICON_SIZES: Record<NodeSize, number> = { lg: 20, md: 16, sm: 14, xs: 10 };

function NodeIcon({
  status,
  nodeType,
  size = "sm",
}: {
  status: TreeNodeStatus;
  nodeType: "root" | "intermediate" | "leaf";
  size?: NodeSize;
}) {
  const iconSize = ICON_SIZES[size];

  if (nodeType === "root") {
    return <Icon icon="solar:lock-keyhole-minimalistic-linear" width={iconSize} />;
  }

  switch (status) {
    case "verified":
      if (nodeType === "leaf") {
        return <Icon icon="solar:file-check-linear" width={iconSize} />;
      }
      return (
        <Icon
          icon="solar:check-read-linear"
          width={iconSize}
          className="text-white"
        />
      );
    case "proving":
      return (
        <Icon
          icon="solar:refresh-linear"
          width={iconSize}
          className="animate-spin"
        />
      );
    case "pending":
      if (nodeType === "leaf") {
        return (
          <Icon
            icon="solar:file-linear"
            width={iconSize}
            className="text-neutral-900"
          />
        );
      }
      return null;
    case "unused":
      return (
        <Icon
          icon="solar:close-circle-linear"
          width={iconSize}
          className={nodeType === "leaf" ? "text-neutral-300" : ""}
        />
      );
  }
}

// --- Legend ---

function TreeLegend() {
  return (
    <div className="flex items-center gap-4 text-xs font-medium text-neutral-500">
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
        Verified
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full border border-blue-500 bg-blue-500 animate-pulse" />
        Proving
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full border border-neutral-900 bg-white" />
        Pending
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
        Unused
      </div>
    </div>
  );
}

// --- Main Component ---

interface MerkleTreeProps {
  /** Bottom-up: [leaves, ...intermediates, root] */
  levels: TreeNode[][];
}

export default function MerkleTree({ levels }: MerkleTreeProps) {
  if (levels.length === 0) {
    return (
      <section className="mb-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
            Merkle Aggregation
          </h2>
          <TreeLegend />
        </div>
        <div className="bg-white rounded-2xl border border-neutral-200 p-12 shadow-sm text-center">
          <Icon
            icon="solar:tree-linear"
            width={48}
            className="text-neutral-300 mx-auto mb-4"
          />
          <p className="text-neutral-500 text-sm">
            Proof tree will appear here during generation.
          </p>
        </div>
      </section>
    );
  }

  const depth = levels.length;
  const leafCount = levels[0].length;

  // Scale node sizes based on leaf count
  const leafSize: NodeSize = leafCount > 16 ? "xs" : "sm";
  const intermediateSize: NodeSize = leafCount > 16 ? "sm" : "md";
  const showLabels = leafCount <= 16;

  // Container height scales with depth
  const containerHeight = Math.max(200, (depth - 1) * 80 + 60);

  // Render top-down (reverse the bottom-up levels array)
  const topDown = [...levels].reverse();

  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
          Merkle Aggregation
        </h2>
        <TreeLegend />
      </div>

      <div className="bg-white rounded-2xl border border-neutral-200 p-8 md:p-12 relative shadow-sm overflow-hidden min-h-[200px] flex flex-col justify-between items-center select-none">
        <div
          className="relative z-10 w-full h-full flex flex-col justify-between"
          style={{ height: containerHeight }}
        >
          {topDown.map((levelNodes, renderIndex) => {
            const depthFromRoot = renderIndex;
            const isRoot = depthFromRoot === 0;
            const isLeaves = renderIndex === depth - 1;

            // Padding: 50 / 2^d % from each side — keeps children centered under parents
            const paddingPct = isRoot ? 0 : 50 / Math.pow(2, depthFromRoot);

            if (isRoot) {
              const node = levelNodes[0];
              return (
                <div key="root" className="flex justify-center w-full">
                  <div className={`${getNodeStyles(node.status, "lg")} relative group`}>
                    <NodeIcon status={node.status} nodeType="root" size="lg" />
                    <span className="absolute -top-8 text-[10px] font-mono text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-900 text-white px-2 py-1 rounded">
                      Root
                    </span>
                  </div>
                </div>
              );
            }

            if (isLeaves) {
              return (
                <div
                  key="leaves"
                  className="flex justify-between w-full"
                  style={{ paddingLeft: `${paddingPct}%`, paddingRight: `${paddingPct}%` }}
                >
                  {levelNodes.map((leaf) => (
                    <div key={leaf.id} className="flex flex-col items-center gap-1">
                      <div
                        className={`${getNodeStyles(leaf.status, leafSize)} ${
                          leaf.status === "verified" ? "ring-2 ring-green-100" : ""
                        }`}
                      >
                        <NodeIcon status={leaf.status} nodeType="leaf" size={leafSize} />
                      </div>
                      {showLabels && (
                        <span
                          className={`text-[10px] font-mono ${
                            leaf.status === "proving"
                              ? "text-blue-600 font-medium"
                              : leaf.status === "unused"
                                ? "text-neutral-300"
                                : "text-neutral-400"
                          }`}
                        >
                          {leaf.label}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              );
            }

            // Intermediate level
            const size = intermediateSize;
            return (
              <div
                key={`level-${renderIndex}`}
                className="flex justify-between w-full"
                style={{ paddingLeft: `${paddingPct}%`, paddingRight: `${paddingPct}%` }}
              >
                {levelNodes.map((node) => (
                  <div key={node.id} className={getNodeStyles(node.status, size)}>
                    <NodeIcon status={node.status} nodeType="intermediate" size={size} />
                    {node.status === "pending" && (
                      <div className="w-2 h-2 bg-neutral-900 rounded-full" />
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
