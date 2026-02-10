"use client";

import { Icon } from "@iconify/react";
import { TreeNode, TreeNodeStatus } from "@/types";

// --- Tree Node Components ---

function getNodeStyles(status: TreeNodeStatus, size: "lg" | "md" | "sm") {
  const sizeClasses = {
    lg: "w-12 h-12",
    md: "w-10 h-10",
    sm: "w-8 h-8",
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

function NodeIcon({
  status,
  nodeType,
}: {
  status: TreeNodeStatus;
  nodeType: "root" | "intermediate" | "leaf";
}) {
  const iconSize = nodeType === "root" ? 20 : nodeType === "intermediate" ? 16 : 14;

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

// --- Line Color Logic ---

type LineStatus = "verified" | "proving" | "pending";

function getLineProps(status: LineStatus) {
  switch (status) {
    case "verified":
      return { stroke: "#22c55e", strokeWidth: 1.5 };
    case "proving":
      return {
        stroke: "#3b82f6",
        strokeWidth: 1.5,
        strokeDasharray: "4 4",
        className: "animate-pulse",
      };
    case "pending":
      return { stroke: "#e5e5e5", strokeWidth: 1.5 };
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
  leaves: TreeNode[];
  intermediatesL2: TreeNode[];
  intermediatesL1: TreeNode[];
  root: TreeNode;
}

export default function MerkleTree({
  leaves,
  intermediatesL2,
  intermediatesL1,
  root,
}: MerkleTreeProps) {
  return (
    <section className="mb-12">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-neutral-900 tracking-tight">
          Merkle Aggregation
        </h2>
        <TreeLegend />
      </div>

      <div className="bg-white rounded-2xl border border-neutral-200 p-8 md:p-12 relative shadow-sm overflow-hidden min-h-[400px] flex flex-col justify-between items-center select-none">
        {/* SVG Connection Lines */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-0"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Root to L1 */}
          <path d="M50% 60 L 30% 160" fill="none" {...getLineProps("pending")} />
          <path d="M50% 60 L 70% 160" fill="none" {...getLineProps("pending")} />

          {/* L1 to L2 (Left - Finished) */}
          <path d="M30% 160 L 15% 260" fill="none" {...getLineProps("verified")} />
          <path d="M30% 160 L 45% 260" fill="none" {...getLineProps("verified")} />

          {/* L1 to L2 (Right - Waiting/Unused) */}
          <path d="M70% 160 L 55% 260" fill="none" {...getLineProps("pending")} />
          <path d="M70% 160 L 85% 260" fill="none" {...getLineProps("pending")} />

          {/* L2 to Leaves (Left Group - Finished) */}
          <path d="M15% 260 L 8% 360" fill="none" {...getLineProps("verified")} />
          <path d="M15% 260 L 22% 360" fill="none" {...getLineProps("verified")} />

          {/* L2 to Leaves (Mid-Left Group - Mixed) */}
          <path d="M45% 260 L 38% 360" fill="none" {...getLineProps("verified")} />
          <path d="M45% 260 L 52% 360" fill="none" {...getLineProps("proving")} />

          {/* L2 to Leaves (Mid-Right Group - Pending/Unused) */}
          <path d="M55% 260 L 48% 360" fill="none" {...getLineProps("pending")} />
          <path d="M55% 260 L 62% 360" fill="none" {...getLineProps("pending")} />

          {/* L2 to Leaves (Right Group - Unused) */}
          <path d="M85% 260 L 78% 360" fill="none" {...getLineProps("pending")} />
          <path d="M85% 260 L 92% 360" fill="none" {...getLineProps("pending")} />
        </svg>

        {/* Tree Nodes */}
        <div
          className="relative z-10 w-full h-full flex flex-col justify-between"
          style={{ height: 320 }}
        >
          {/* Level 0: Root */}
          <div className="flex justify-center w-full">
            <div className={`${getNodeStyles(root.status, "lg")} relative group`}>
              <NodeIcon status={root.status} nodeType="root" />
              <span className="absolute -top-8 text-[10px] font-mono text-neutral-400 opacity-0 group-hover:opacity-100 transition-opacity bg-neutral-900 text-white px-2 py-1 rounded">
                Root
              </span>
            </div>
          </div>

          {/* Level 1: Intermediates */}
          <div className="flex justify-between w-full px-[20%]">
            {intermediatesL1.map((node) => (
              <div key={node.id} className={getNodeStyles(node.status, "md")}>
                <Icon
                  icon="solar:hashtag-linear"
                  width={16}
                  className={
                    node.status === "unused"
                      ? "text-neutral-300"
                      : "text-neutral-900"
                  }
                />
              </div>
            ))}
          </div>

          {/* Level 2: Intermediates */}
          <div className="flex justify-between w-full px-[5%]">
            {intermediatesL2.map((node) => {
              const styles = getNodeStyles(node.status, "sm");
              return (
                <div key={node.id} className={styles}>
                  <NodeIcon status={node.status} nodeType="intermediate" />
                  {node.status === "pending" && (
                    <div className="w-2 h-2 bg-neutral-900 rounded-full" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Level 3: Leaves */}
          <div className="flex justify-between w-full px-[1%]">
            {leaves.map((leaf) => (
              <div key={leaf.id} className="flex flex-col items-center gap-2">
                <div
                  className={`${getNodeStyles(leaf.status, "sm")} ${
                    leaf.status === "verified" ? "ring-2 ring-green-100" : ""
                  }`}
                >
                  <NodeIcon status={leaf.status} nodeType="leaf" />
                </div>
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
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
