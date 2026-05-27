"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BoxSelect, Columns2, Copy, Download, ImagePlus, LoaderCircle, LocateFixed, Maximize2, Plus, RefreshCcw, Save, ScissorsLineDashed, Star, Trash2, Workflow, X, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";

import { ImageComposer } from "@/app/image/components/image-composer";
import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_REVERSE_PROMPT_INSTRUCTION, cancelImageTasks, createImageEditTaskFromSource, createImageEditTaskFromSources, createImageGenerationTask, createReversePromptTask, fetchAccounts, fetchImageTasks, fetchReversePromptInstruction, updateReversePromptInstruction, type Account, type ImageTask } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAuthGuard } from "@/lib/use-auth-guard";
import {
  createBlankImageCanvasProject,
  createImageCanvasId,
  deleteImageCanvasProject,
  listImageCanvasProjects,
  saveImageCanvasProject,
  type ImageCanvasEdge,
  type ImageCanvasNode,
  type ImageCanvasNodeStatus,
  type ImageCanvasProject,
  type ImageCanvasViewport,
} from "@/store/image-canvas";

const ACTIVE_PROJECT_KEY = "chatgpt2api:image_canvas_active_project_id";
const IMAGE_SIZE_STORAGE_KEY = "chatgpt2api:image_last_size";
const IMAGE_COUNT_STORAGE_KEY = "chatgpt2api:image_last_count";
const nodeSize = {
  prompt: { width: 320, height: 220 },
  edit: { width: 320, height: 220 },
  image: { width: 300, height: 286 },
};
const GENERATION_RESULT_X_OFFSET = 430;
const GENERATION_RESULT_Y_STEP = 330;
const edgePalette = [
  { stroke: "#2563eb", glow: "rgba(37,99,235,0.14)" },
  { stroke: "#059669", glow: "rgba(5,150,105,0.14)" },
  { stroke: "#d97706", glow: "rgba(217,119,6,0.16)" },
  { stroke: "#dc2626", glow: "rgba(220,38,38,0.13)" },
  { stroke: "#7c3aed", glow: "rgba(124,58,237,0.13)" },
  { stroke: "#0891b2", glow: "rgba(8,145,178,0.14)" },
  { stroke: "#be123c", glow: "rgba(190,18,60,0.13)" },
  { stroke: "#4f46e5", glow: "rgba(79,70,229,0.13)" },
];

type DragState =
  | {
      type: "pan";
      startX: number;
      startY: number;
      baseViewport: ImageCanvasViewport;
    }
  | {
      type: "node";
      nodeId: string;
      startX: number;
      startY: number;
      baseX: number;
      baseY: number;
      zoom: number;
    };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function clampCount(value: string) {
  return String(Math.min(100, Math.max(1, Math.floor(Number(value) || 1))));
}

type CanvasReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

function formatAvailableQuota(accounts: Account[]) {
  const availableAccounts = accounts.filter((account) => account.status !== "禁用");
  return String(availableAccounts.reduce((sum, account) => sum + Math.max(0, account.quota), 0));
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取参考图失败"));
    reader.readAsDataURL(file);
  });
}

function referenceImageToSource(image: CanvasReferenceImage) {
  return {
    data: image.dataUrl,
    filename: image.name,
    mime: image.type || "image/png",
  };
}

function buildProjectTitle(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return "未命名画布";
  return trimmed.length > 14 ? `${trimmed.slice(0, 14)}...` : trimmed;
}

function safeFileName(value: string, fallback: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return (normalized || fallback).slice(0, 80);
}

function downloadJsonFile(fileName: string, value: object) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getImageNodeSrc(node: ImageCanvasNode) {
  if (node.b64_json) return `data:image/png;base64,${node.b64_json}`;
  return node.url || "";
}

function getStatusLabel(status: ImageCanvasNodeStatus) {
  if (status === "queued") return "排队中";
  if (status === "generating") return "处理中";
  if (status === "success") return "完成";
  if (status === "error") return "失败";
  if (status === "cancelled") return "已取消";
  return "草稿";
}

function clampProgress(value: unknown, fallback: number) {
  const raw = Number(value ?? fallback);
  return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : fallback;
}

function getNodeProgress(node: ImageCanvasNode) {
  const fallback = node.status === "queued" ? 0 : node.status === "generating" ? 15 : node.status === "idle" ? 0 : 100;
  return clampProgress(node.progress, fallback);
}

function getTaskStatus(task: ImageTask): ImageCanvasNodeStatus {
  if (task.status === "queued") return "queued";
  if (task.status === "running") return "generating";
  if (task.status === "success") return "success";
  if (task.status === "cancelled") return "cancelled";
  return "error";
}

function taskToImageNode(node: ImageCanvasNode, task: ImageTask): ImageCanvasNode {
  const status = getTaskStatus(task);
  const progress = clampProgress(task.progress, status === "queued" ? 0 : status === "generating" ? 15 : 100);
  const progressMessage = task.progress_message || getStatusLabel(status);
  if (status === "success") {
    const first = task.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return {
        ...node,
        taskId: task.id,
        status: "error",
        progress: 100,
        progressMessage: task.progress_message || "失败",
        error: "未返回图片数据",
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      ...node,
      taskId: task.id,
      status: "success",
      progress: 100,
      progressMessage: task.progress_message || "已完成",
      b64_json: first.b64_json,
      url: first.url,
      revised_prompt: first.revised_prompt,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...node,
    taskId: task.id,
    status,
    progress,
    progressMessage,
    error: status === "error" || status === "cancelled" ? task.error || getStatusLabel(status) : undefined,
    updatedAt: new Date().toISOString(),
  };
}

function reversePromptFromTask(task: ImageTask) {
  return task.message?.trim() || task.data?.[0]?.revised_prompt?.trim() || "";
}

function imageNodeToSource(node: ImageCanvasNode) {
  if (node.b64_json) {
    return {
      base64: node.b64_json,
      mime: "image/png",
      filename: `${node.id}.png`,
    };
  }
  if (node.url) {
    return {
      url: node.url,
      filename: `${node.id}.png`,
    };
  }
  return null;
}

async function downloadImageNode(node: ImageCanvasNode) {
  const src = getImageNodeSrc(node);
  if (!src) return;
  let blob: Blob;
  if (node.b64_json) {
    const binary = atob(node.b64_json);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    blob = new Blob([bytes], { type: "image/png" });
  } else {
    const response = await fetch(src);
    blob = await response.blob();
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${node.title || node.id}.png`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getEdgePath(from: ImageCanvasNode, to: ImageCanvasNode) {
  const fromCenterX = from.x + from.width / 2;
  const toCenterX = to.x + to.width / 2;
  const isDownward = to.y > from.y + from.height && Math.abs(fromCenterX - toCenterX) < Math.max(from.width, to.width);
  if (isDownward) {
    const startX = fromCenterX;
    const startY = from.y + from.height;
    const endX = toCenterX;
    const endY = to.y;
    const bend = Math.max(70, (endY - startY) * 0.5);
    return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX} ${endY - bend}, ${endX} ${endY}`;
  }

  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const bend = Math.max(80, Math.abs(endX - startX) * 0.45);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getEdgeBranchKey(edge: ImageCanvasEdge, from: ImageCanvasNode, to: ImageCanvasNode) {
  if (from.type === "edit") return from.id;
  if (to.type === "edit") return to.id;
  if (from.type === "prompt") return from.id;
  return edge.from;
}

function getEdgePaletteItemForKey(key: string) {
  return edgePalette[hashString(key) % edgePalette.length] || edgePalette[0];
}

type SelectedUpstreamHighlight = {
  edgeIds: Set<string>;
  nodeColors: Map<string, string>;
  stroke: string;
  glow: string;
};

function getSelectedUpstreamHighlight(project: ImageCanvasProject, selectedNodeId: string | null): SelectedUpstreamHighlight {
  const empty: SelectedUpstreamHighlight = {
    edgeIds: new Set<string>(),
    nodeColors: new Map<string, string>(),
    stroke: "",
    glow: "",
  };
  if (!selectedNodeId) return empty;

  const nodeMap = new Map(project.nodes.map((node) => [node.id, node]));
  const selectedNode = nodeMap.get(selectedNodeId);
  if (!selectedNode) return empty;

  const incomingEdges = project.edges.filter((edge) => edge.to === selectedNodeId && nodeMap.has(edge.from));
  const firstIncomingEdge = incomingEdges[0];
  const firstIncomingFrom = firstIncomingEdge ? nodeMap.get(firstIncomingEdge.from) : null;
  const branchKey =
    firstIncomingEdge && firstIncomingFrom
      ? getEdgeBranchKey(firstIncomingEdge, firstIncomingFrom, selectedNode)
      : selectedNode.sourceNodeId || selectedNode.id;
  const paletteItem = getEdgePaletteItemForKey(branchKey);
  const highlight: SelectedUpstreamHighlight = {
    edgeIds: new Set<string>(),
    nodeColors: new Map<string, string>(),
    stroke: paletteItem.stroke,
    glow: paletteItem.glow,
  };

  const stack = [selectedNodeId];
  const visited = new Set<string>([selectedNodeId]);
  while (stack.length > 0) {
    const nodeId = stack.pop();
    if (!nodeId) continue;
    for (const edge of project.edges) {
      if (edge.to !== nodeId) continue;
      const from = nodeMap.get(edge.from);
      const to = nodeMap.get(edge.to);
      if (!from || !to) continue;
      highlight.edgeIds.add(edge.id);
      if (edge.from !== selectedNodeId) {
        highlight.nodeColors.set(edge.from, highlight.stroke);
      }
      if (!visited.has(edge.from)) {
        visited.add(edge.from);
        stack.push(edge.from);
      }
    }
  }

  return highlight;
}

function getEdgeVisual(edge: ImageCanvasEdge, from: ImageCanvasNode, to: ImageCanvasNode, selectedNodeId: string | null, upstreamHighlight: SelectedUpstreamHighlight) {
  const defaultPaletteItem = getEdgePaletteItemForKey(getEdgeBranchKey(edge, from, to));
  const isUpstreamEdge = upstreamHighlight.edgeIds.has(edge.id);
  const paletteItem = isUpstreamEdge
    ? {
        stroke: upstreamHighlight.stroke || defaultPaletteItem.stroke,
        glow: upstreamHighlight.glow || defaultPaletteItem.glow,
      }
    : defaultPaletteItem;
  const isSelectedEdge = Boolean(selectedNodeId && (edge.from === selectedNodeId || edge.to === selectedNodeId));
  const hasSelection = Boolean(selectedNodeId);
  return {
    ...paletteItem,
    dashArray: to.type === "edit" ? "8 8" : undefined,
    opacity: hasSelection && !isSelectedEdge && !isUpstreamEdge ? 0.26 : isUpstreamEdge ? 0.96 : 0.82,
    glowOpacity: hasSelection && !isSelectedEdge && !isUpstreamEdge ? 0.12 : 1,
    strokeWidth: isUpstreamEdge ? 4 : isSelectedEdge ? 3.6 : 2.7,
  };
}

function hasMeaningfulImageNodeChange(current: ImageCanvasNode, next: ImageCanvasNode) {
  return (
    current.taskId !== next.taskId ||
    current.status !== next.status ||
    current.progress !== next.progress ||
    current.progressMessage !== next.progressMessage ||
    current.b64_json !== next.b64_json ||
    current.url !== next.url ||
    current.revised_prompt !== next.revised_prompt ||
    current.error !== next.error
  );
}

function nodeStatusClass(status: ImageCanvasNodeStatus) {
  if (status === "success") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "error" || status === "cancelled") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "queued" || status === "generating") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-stone-200 bg-stone-50 text-stone-500";
}

function findProject(projects: ImageCanvasProject[], id: string | null) {
  if (!id) return null;
  return projects.find((project) => project.id === id) ?? null;
}

function getNodeTypeLabel(type: ImageCanvasNode["type"]) {
  if (type === "image") return "图片";
  if (type === "edit") return "编辑";
  return "提示词";
}

function getNodePreview(node: ImageCanvasNode) {
  if (node.status === "queued" || node.status === "generating") {
    return `${node.progressMessage || getStatusLabel(node.status)} ${getNodeProgress(node)}%`;
  }
  return node.prompt || node.revised_prompt || node.error || node.size || getStatusLabel(node.status);
}

function getCanvasBounds(nodes: ImageCanvasNode[]) {
  if (nodes.length === 0) return null;
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

type CanvasRect = { x: number; y: number; width: number; height: number };
type CanvasPlacement = { x: number; y: number };

function rectsOverlap(rectA: CanvasRect, rectB: CanvasRect, gap = 36) {
  return !(
    rectA.x + rectA.width + gap <= rectB.x ||
    rectB.x + rectB.width + gap <= rectA.x ||
    rectA.y + rectA.height + gap <= rectB.y ||
    rectB.y + rectB.height + gap <= rectA.y
  );
}

function branchOverlapsNodes(branchRects: CanvasRect[], nodes: ImageCanvasNode[]) {
  return branchRects.some((rect) =>
    nodes.some((node) => rectsOverlap(rect, {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    })),
  );
}

function findNonOverlappingCanvasPosition(
  nodes: ImageCanvasNode[],
  initial: CanvasPlacement,
  buildRects: (placement: CanvasPlacement) => CanvasRect[],
) {
  if (nodes.length === 0) return initial;
  let placement = initial;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const rects = buildRects(placement);
    if (!branchOverlapsNodes(rects, nodes)) {
      return placement;
    }
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    placement = {
      ...placement,
      y: placement.y + Math.max(220, maxY - minY + 96),
    };
  }

  const bounds = getCanvasBounds(nodes);
  if (!bounds) return placement;
  const rects = buildRects(placement);
  const minY = Math.min(...rects.map((rect) => rect.y));
  return {
    ...placement,
    y: placement.y + Math.max(0, bounds.maxY + 120 - minY),
  };
}

function generationBranchRects(origin: CanvasPlacement, count: number): CanvasRect[] {
  return [
    {
      x: origin.x,
      y: origin.y,
      width: nodeSize.prompt.width,
      height: nodeSize.prompt.height,
    },
    ...Array.from({ length: count }, (_, index) => ({
      x: origin.x + GENERATION_RESULT_X_OFFSET,
      y: origin.y + index * GENERATION_RESULT_Y_STEP,
      width: nodeSize.image.width,
      height: nodeSize.image.height,
    })),
  ];
}

function viewportForBounds(bounds: NonNullable<ReturnType<typeof getCanvasBounds>>, viewportWidth: number, viewportHeight: number) {
  const padding = 96;
  const zoom = clamp(Math.min((viewportWidth - padding * 2) / Math.max(bounds.width, 1), (viewportHeight - padding * 2) / Math.max(bounds.height, 1)), 0.35, 1.18);
  return {
    x: (viewportWidth - bounds.width * zoom) / 2 - bounds.minX * zoom,
    y: (viewportHeight - bounds.height * zoom) / 2 - bounds.minY * zoom,
    zoom,
  };
}

function getConnectedNodeGroups(nodes: ImageCanvasNode[], edges: ImageCanvasEdge[]) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const visited = new Set<string>();
  const groups: ImageCanvasNode[][] = [];
  const compareOriginalPosition = (nodeA: ImageCanvasNode, nodeB: ImageCanvasNode) => nodeA.y - nodeB.y || nodeA.x - nodeB.x;
  for (const node of [...nodes].sort(compareOriginalPosition)) {
    if (visited.has(node.id)) continue;
    const group: ImageCanvasNode[] = [];
    const stack = [node.id];
    visited.add(node.id);
    while (stack.length > 0) {
      const nodeId = stack.pop();
      const item = nodeId ? nodeMap.get(nodeId) : null;
      if (!item) continue;
      group.push(item);
      for (const nextId of adjacency.get(item.id) || []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        stack.push(nextId);
      }
    }
    group.sort(compareOriginalPosition);
    groups.push(group);
  }

  return groups.sort((groupA, groupB) => {
    const boundsA = getCanvasBounds(groupA);
    const boundsB = getCanvasBounds(groupB);
    return (boundsA?.minY ?? 0) - (boundsB?.minY ?? 0) || (boundsA?.minX ?? 0) - (boundsB?.minX ?? 0);
  });
}

function layoutConnectedCanvasNodes(nodes: ImageCanvasNode[], edges: ImageCanvasEdge[]) {
  if (nodes.length === 0) return nodes;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const validEdges = edges.filter((edge) => nodeMap.has(edge.from) && nodeMap.has(edge.to));
  const childrenMap = new Map<string, string[]>();
  const parentMap = new Map<string, string[]>();
  for (const node of nodes) {
    childrenMap.set(node.id, []);
    parentMap.set(node.id, []);
  }
  for (const edge of validEdges) {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
    childrenMap.set(edge.from, [...(childrenMap.get(edge.from) || []), edge.to]);
    parentMap.set(edge.to, [...(parentMap.get(edge.to) || []), edge.from]);
  }
  for (const children of childrenMap.values()) {
    children.sort((a, b) => {
      const nodeA = nodeMap.get(a);
      const nodeB = nodeMap.get(b);
      return (nodeA?.x ?? 0) - (nodeB?.x ?? 0) || (nodeA?.y ?? 0) - (nodeB?.y ?? 0);
    });
  }

  const originalOrder = new Map(
    [...nodes]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((node, index) => [node.id, index]),
  );
  const compareOriginalPosition = (a: string, b: string) => {
    const nodeA = nodeMap.get(a);
    const nodeB = nodeMap.get(b);
    return (
      (nodeA?.y ?? 0) - (nodeB?.y ?? 0) ||
      (nodeA?.x ?? 0) - (nodeB?.x ?? 0) ||
      (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0)
    );
  };

  const layers = new Map(nodes.map((node) => [node.id, 0]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of validEdges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  }
  const queue = nodes
    .filter((node) => (indegree.get(node.id) || 0) === 0)
    .map((node) => node.id)
    .sort(compareOriginalPosition);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    visited.add(nodeId);
    for (const childId of childrenMap.get(nodeId) || []) {
      layers.set(childId, Math.max(layers.get(childId) || 0, (layers.get(nodeId) || 0) + 1));
      indegree.set(childId, (indegree.get(childId) || 0) - 1);
      if ((indegree.get(childId) || 0) === 0) {
        queue.push(childId);
        queue.sort(compareOriginalPosition);
      }
    }
  }
  for (const node of nodes) {
    if (!visited.has(node.id) && !layers.has(node.id)) {
      layers.set(node.id, 0);
    }
  }

  for (let iteration = 0; iteration < nodes.length * 3; iteration += 1) {
    let changed = false;
    for (const node of nodes) {
      if (node.type !== "edit") continue;
      const sourceIds = (parentMap.get(node.id) || []).filter((id) => nodeMap.get(id)?.type === "image");
      if (sourceIds.length < 2) continue;
      const sourceLayer = Math.max(...sourceIds.map((id) => layers.get(id) || 0));
      for (const sourceId of sourceIds) {
        if ((layers.get(sourceId) || 0) < sourceLayer) {
          layers.set(sourceId, sourceLayer);
          changed = true;
        }
      }
    }
    for (const edge of validEdges) {
      const requiredLayer = (layers.get(edge.from) || 0) + 1;
      if ((layers.get(edge.to) || 0) < requiredLayer) {
        layers.set(edge.to, requiredLayer);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const gapX = 52;
  const gapY = 92;
  const startX = 100;
  const startY = 92;
  const positions = new Map<string, { x: number; y: number }>();
  const layerNumbers = [...new Set(nodes.map((node) => layers.get(node.id) || 0))].sort((a, b) => a - b);
  const rowMap = new Map<number, ImageCanvasNode[]>();
  const editSourceOrder = (nodeId: string) => {
    const editChildren = (childrenMap.get(nodeId) || []).filter((id) => nodeMap.get(id)?.type === "edit");
    if (editChildren.length === 0) return null;
    return editChildren.reduce((total, id) => total + (originalOrder.get(id) || 0), 0) / editChildren.length;
  };
  const rowOrder = new Map<string, number>();
  let rowTop = startY;
  for (const layer of layerNumbers) {
    const row = nodes.filter((node) => (layers.get(node.id) || 0) === layer);
    row.sort((a, b) => {
      const sourceOrderA = a.type === "image" ? editSourceOrder(a.id) : null;
      const sourceOrderB = b.type === "image" ? editSourceOrder(b.id) : null;
      const parentOrderA = (parentMap.get(a.id) || [])
        .map((id) => rowOrder.get(id))
        .filter((value): value is number => typeof value === "number");
      const parentOrderB = (parentMap.get(b.id) || [])
        .map((id) => rowOrder.get(id))
        .filter((value): value is number => typeof value === "number");
      const orderA = sourceOrderA ?? (parentOrderA.length > 0 ? parentOrderA.reduce((sum, value) => sum + value, 0) / parentOrderA.length : null);
      const orderB = sourceOrderB ?? (parentOrderB.length > 0 ? parentOrderB.reduce((sum, value) => sum + value, 0) / parentOrderB.length : null);
      if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB;
      if (orderA !== null && orderB === null) return -1;
      if (orderA === null && orderB !== null) return 1;
      return compareOriginalPosition(a.id, b.id);
    });
    rowMap.set(layer, row);
    let rowLeft = startX;
    for (const [index, node] of row.entries()) {
      positions.set(node.id, { x: rowLeft, y: rowTop });
      rowOrder.set(node.id, index);
      rowLeft += node.width + gapX;
    }
    rowTop += Math.max(...row.map((node) => node.height), 0) + gapY;
  }

  const boundsForNodes = (ids: string[]) => {
    const sourceNodes = ids
      .map((id) => {
        const node = nodeMap.get(id);
        const position = positions.get(id);
        return node && position ? { node, position } : null;
      })
      .filter((item): item is { node: ImageCanvasNode; position: { x: number; y: number } } => Boolean(item));
    if (sourceNodes.length === 0) return null;
    const minX = Math.min(...sourceNodes.map(({ position }) => position.x));
    const maxX = Math.max(...sourceNodes.map(({ node, position }) => position.x + node.width));
    return { minX, maxX, width: maxX - minX };
  };
  const centerNodeOver = (nodeId: string, ids: string[]) => {
    const node = nodeMap.get(nodeId);
    const position = positions.get(nodeId);
    const bounds = boundsForNodes(ids);
    if (!node || !position || !bounds) return;
    position.x = bounds.minX + bounds.width / 2 - node.width / 2;
  };
  const placeChildrenUnder = (nodeId: string, childIds: string[]) => {
    const node = nodeMap.get(nodeId);
    const position = positions.get(nodeId);
    const children = childIds
      .map((id) => nodeMap.get(id))
      .filter((child): child is ImageCanvasNode => Boolean(child))
      .sort((a, b) => (positions.get(a.id)?.x ?? 0) - (positions.get(b.id)?.x ?? 0) || compareOriginalPosition(a.id, b.id));
    if (!node || !position || children.length === 0) return;
    const totalWidth = children.reduce((total, child) => total + child.width, 0) + (children.length - 1) * gapX;
    let childLeft = position.x + node.width / 2 - totalWidth / 2;
    for (const child of children) {
      const childPosition = positions.get(child.id);
      if (childPosition) {
        childPosition.x = childLeft;
        childLeft += child.width + gapX;
      }
    }
  };
  const resolveRowCollisions = () => {
    for (const row of rowMap.values()) {
      const ordered = [...row].sort((a, b) => (positions.get(a.id)?.x ?? 0) - (positions.get(b.id)?.x ?? 0) || compareOriginalPosition(a.id, b.id));
      let rowLeft = startX;
      for (const node of ordered) {
        const position = positions.get(node.id);
        if (!position) continue;
        if (position.x < rowLeft) {
          position.x = rowLeft;
        }
        rowLeft = position.x + node.width + gapX;
      }
    }
  };

  for (let iteration = 0; iteration < 2; iteration += 1) {
    for (const node of nodes) {
      if (node.type === "prompt") {
        centerNodeOver(node.id, (childrenMap.get(node.id) || []).filter((id) => nodeMap.get(id)?.type === "image"));
      }
      if (node.type === "edit") {
        centerNodeOver(node.id, (parentMap.get(node.id) || []).filter((id) => nodeMap.get(id)?.type === "image"));
        placeChildrenUnder(node.id, (childrenMap.get(node.id) || []).filter((id) => nodeMap.get(id)?.type === "image"));
      }
    }
    resolveRowCollisions();
  }

  const now = new Date().toISOString();
  return nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, x: position.x, y: position.y, updatedAt: now } : node;
  });
}

function layoutCanvasNodes(nodes: ImageCanvasNode[], edges: ImageCanvasEdge[]) {
  if (nodes.length === 0) return nodes;
  const groups = getConnectedNodeGroups(nodes, edges);

  const startX = 100;
  const startY = 92;
  const maxRowRight = 5200;
  const groupGapX = 220;
  const groupGapY = 180;
  const positioned = new Map<string, ImageCanvasNode>();
  let rowLeft = startX;
  let rowTop = startY;
  let rowHeight = 0;
  const now = new Date().toISOString();

  for (const group of groups) {
    const bounds = getCanvasBounds(group);
    if (!bounds) continue;
    if (rowLeft > startX && rowLeft + bounds.width > maxRowRight) {
      rowLeft = startX;
      rowTop += rowHeight + groupGapY;
      rowHeight = 0;
    }
    const offsetX = rowLeft - bounds.minX;
    const offsetY = rowTop - bounds.minY;
    const movedGroup = group.map((node) => ({
      ...node,
      x: node.x + offsetX,
      y: node.y + offsetY,
      updatedAt: now,
    }));
    for (const node of movedGroup) {
      positioned.set(node.id, node);
    }
    const movedBounds = getCanvasBounds(movedGroup);
    rowLeft = (movedBounds?.maxX ?? rowLeft) + groupGapX;
    rowHeight = Math.max(rowHeight, movedBounds?.height ?? bounds.height);
  }

  return nodes.map((node) => positioned.get(node.id) || node);
}

function CanvasPageContent({ isAdmin, ownerKey }: { isAdmin: boolean; ownerKey: string }) {
  const didLoadQuotaRef = useRef(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const reversePromptFileInputRef = useRef<HTMLInputElement>(null);
  const activeProjectRef = useRef<ImageCanvasProject | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [projects, setProjects] = useState<ImageCanvasProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<ImageCanvasProject | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [saveState, setSaveState] = useState<"saved" | "saving">("saved");
  const [promptDraft, setPromptDraft] = useState("");
  const [countDraft, setCountDraft] = useState("1");
  const [sizeDraft, setSizeDraft] = useState("");
  const [referenceImages, setReferenceImages] = useState<CanvasReferenceImage[]>([]);
  const [reversePromptImage, setReversePromptImage] = useState<CanvasReferenceImage | null>(null);
  const [reversePromptResult, setReversePromptResult] = useState("");
  const [reversePromptInstruction, setReversePromptInstruction] = useState(DEFAULT_REVERSE_PROMPT_INSTRUCTION);
  const [isLoadingReversePromptInstruction, setIsLoadingReversePromptInstruction] = useState(false);
  const [isSavingReversePromptInstruction, setIsSavingReversePromptInstruction] = useState(false);
  const [isReversingPrompt, setIsReversingPrompt] = useState(false);
  const [reversePromptTaskId, setReversePromptTaskId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxImages, setLightboxImages] = useState<Array<{ id: string; src: string; sizeLabel?: string }>>([]);
  const [compareNodeIds, setCompareNodeIds] = useState<string[]>([]);
  const [availableQuota, setAvailableQuota] = useState("加载中...");

  const activeProject = useMemo(() => findProject(projects, activeProjectId), [projects, activeProjectId]);
  const activeProjectStorageKey = `${ACTIVE_PROJECT_KEY}:${ownerKey || "default"}`;
  const selectedNode = useMemo(
    () => activeProject?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [activeProject, selectedNodeId],
  );
  const successfulSelectedImage = selectedNode?.type === "image" && selectedNode.status === "success" ? selectedNode : null;
  const selectedEditNode = selectedNode?.type === "edit" ? selectedNode : null;
  const runningCount = useMemo(
    () => activeProject?.nodes.filter((node) => node.type === "image" && (node.status === "queued" || node.status === "generating")).length ?? 0,
    [activeProject],
  );
  const projectLightboxImages = useMemo(
    () =>
      (activeProject?.nodes || [])
        .filter((node) => node.type === "image" && node.status === "success" && getImageNodeSrc(node))
        .map((node) => ({
          id: node.id,
          src: getImageNodeSrc(node),
          sizeLabel: node.size || undefined,
        })),
    [activeProject],
  );
  const compareNodes = useMemo(
    () =>
      compareNodeIds
        .map((id) => activeProject?.nodes.find((node) => node.id === id))
        .filter((node): node is ImageCanvasNode => Boolean(node && node.type === "image" && node.status === "success" && getImageNodeSrc(node))),
    [activeProject, compareNodeIds],
  );

  useEffect(() => {
    activeProjectRef.current = activeProject;
  }, [activeProject]);

  useEffect(() => {
    if (!selectedEditNode) return;
    setPromptDraft(selectedEditNode.prompt || "");
    setCountDraft(String(Math.max(1, Number(selectedEditNode.count || 1) || 1)));
    setSizeDraft(selectedEditNode.size || "");
    setReferenceImages([]);
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }, [selectedEditNode?.id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const storedSize = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_SIZE_STORAGE_KEY) : null;
        const storedCount = typeof window !== "undefined" ? window.localStorage.getItem(IMAGE_COUNT_STORAGE_KEY) : null;
        setSizeDraft(storedSize || "");
        setCountDraft(storedCount ? clampCount(storedCount) : "1");

        const stored = await listImageCanvasProjects();
        let nextProjects = stored;
        if (nextProjects.length === 0) {
          const project = createBlankImageCanvasProject("我的画布");
          await saveImageCanvasProject(project);
          nextProjects = [project];
        }
        if (cancelled) return;
        setProjects(nextProjects);
        const storedActiveId = typeof window !== "undefined" ? window.localStorage.getItem(activeProjectStorageKey) : null;
        setActiveProjectId(nextProjects.some((project) => project.id === storedActiveId) ? storedActiveId : nextProjects[0].id);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取画布失败");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [activeProjectStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeProjectId) {
      window.localStorage.setItem(activeProjectStorageKey, activeProjectId);
    }
  }, [activeProjectId, activeProjectStorageKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sizeDraft) {
      window.localStorage.setItem(IMAGE_SIZE_STORAGE_KEY, sizeDraft);
      return;
    }
    window.localStorage.removeItem(IMAGE_SIZE_STORAGE_KEY);
  }, [sizeDraft]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(IMAGE_COUNT_STORAGE_KEY, clampCount(countDraft));
    }
  }, [countDraft]);

  useEffect(() => {
    let cancelled = false;
    const loadReversePromptInstruction = async () => {
      setIsLoadingReversePromptInstruction(true);
      try {
        const data = await fetchReversePromptInstruction();
        if (!cancelled) {
          setReversePromptInstruction(data.instruction || DEFAULT_REVERSE_PROMPT_INSTRUCTION);
        }
      } catch {
        if (!cancelled) {
          setReversePromptInstruction(DEFAULT_REVERSE_PROMPT_INSTRUCTION);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingReversePromptInstruction(false);
        }
      }
    };
    void loadReversePromptInstruction();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadQuota = useCallback(async () => {
    if (!isAdmin) {
      setAvailableQuota("--");
      return;
    }
    try {
      const data = await fetchAccounts();
      setAvailableQuota(formatAvailableQuota(data.items));
    } catch {
      setAvailableQuota((current) => (current === "加载中..." ? "--" : current));
    }
  }, [isAdmin]);

  useEffect(() => {
    if (didLoadQuotaRef.current) return;
    didLoadQuotaRef.current = true;
    const handleFocus = () => {
      void loadQuota();
    };
    void loadQuota();
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadQuota]);

  const applyLocalProject = useCallback((project: ImageCanvasProject) => {
    activeProjectRef.current = project;
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
  }, []);

  const persistProject = useCallback(async (project: ImageCanvasProject) => {
    const nextProject = { ...project, updatedAt: new Date().toISOString() };
    applyLocalProject(nextProject);
    setSaveState("saving");
    await saveImageCanvasProject(nextProject);
    setSaveState("saved");
    return nextProject;
  }, [applyLocalProject]);

  const updateActiveProject = useCallback(
    async (updater: (project: ImageCanvasProject) => ImageCanvasProject) => {
      const project = activeProjectRef.current;
      if (!project) return null;
      return persistProject(updater(project));
    },
    [persistProject],
  );

  const patchImageNode = useCallback(
    async (nodeId: string, patch: Partial<ImageCanvasNode>) => {
      await updateActiveProject((project) => ({
        ...project,
        nodes: project.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch, updatedAt: new Date().toISOString() } : node)),
      }));
    },
    [updateActiveProject],
  );

  const syncImageTasks = useCallback(async () => {
    const project = activeProjectRef.current;
    if (!project) return;
    const taskIds = project.nodes.flatMap((node) =>
      node.type === "image" && (node.status === "queued" || node.status === "generating") && node.taskId ? [node.taskId] : [],
    );
    if (taskIds.length === 0) return;
    try {
      const taskList = await fetchImageTasks(Array.from(new Set(taskIds)));
      const taskMap = new Map(taskList.items.map((task) => [task.id, task]));
      let changed = false;
      const nodes = project.nodes.map((node) => {
        if (!node.taskId) return node;
        const task = taskMap.get(node.taskId);
        if (!task) return node;
        const nextNode = taskToImageNode(node, task);
        if (!hasMeaningfulImageNodeChange(node, nextNode)) {
          return node;
        }
        changed = true;
        return nextNode;
      });
      if (changed) {
        await persistProject({ ...project, nodes });
      }
    } catch {
      // 页面轮询失败时保留当前画布状态，下一轮继续同步。
    }
  }, [persistProject]);

  useEffect(() => {
    if (!activeProject || runningCount === 0) return;
    const timer = window.setInterval(() => {
      void syncImageTasks();
    }, 3000);
    void syncImageTasks();
    return () => {
      window.clearInterval(timer);
    };
  }, [activeProjectId, runningCount, syncImageTasks]);

  const getCanvasPoint = useCallback(
    (clientX?: number, clientY?: number) => {
      const project = activeProjectRef.current;
      const viewport = project?.viewport ?? { x: 80, y: 64, zoom: 1 };
      const rect = canvasRef.current?.getBoundingClientRect();
      const x = clientX && rect ? clientX - rect.left : (rect?.width || 1200) / 2;
      const y = clientY && rect ? clientY - rect.top : (rect?.height || 700) / 2;
      return {
        x: (x - viewport.x) / viewport.zoom,
        y: (y - viewport.y) / viewport.zoom,
      };
    },
    [],
  );

  const clearComposerInputs = useCallback(() => {
    setPromptDraft("");
    setReferenceImages([]);
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }, []);

  const appendReferenceImages = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const images = await Promise.all(
        files
          .filter((file) => file.type.startsWith("image/"))
          .map(async (file) => ({
            name: file.name,
            type: file.type || "image/png",
            dataUrl: await readFileAsDataUrl(file),
          })),
      );
      if (images.length === 0) return;
      setReferenceImages((current) => [...current, ...images]);
      if (composerFileInputRef.current) {
        composerFileInputRef.current.value = "";
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取参考图失败");
    }
  }, []);

  const handleRemoveReferenceImage = useCallback((index: number) => {
    setReferenceImages((current) => current.filter((_, currentIndex) => currentIndex !== index));
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
  }, []);

  const setReversePromptImageFromFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("请选择图片文件");
      return;
    }
    try {
      setReversePromptImage({
        name: file.name,
        type: file.type || "image/png",
        dataUrl: await readFileAsDataUrl(file),
      });
      setReversePromptResult("");
      if (reversePromptFileInputRef.current) {
        reversePromptFileInputRef.current.value = "";
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取图片失败");
    }
  }, []);

  const clearReversePromptImage = useCallback(() => {
    setReversePromptTaskId((taskId) => {
      if (taskId) {
        void cancelImageTasks([taskId]);
      }
      return null;
    });
    setIsReversingPrompt(false);
    setReversePromptImage(null);
    setReversePromptResult("");
    if (reversePromptFileInputRef.current) {
      reversePromptFileInputRef.current.value = "";
    }
  }, []);

  const useSelectedImageForReversePrompt = useCallback(() => {
    if (!successfulSelectedImage) return;
    const src = getImageNodeSrc(successfulSelectedImage);
    if (!src) {
      toast.error("这张图片没有可读取的数据");
      return;
    }
    setReversePromptImage({
      name: `${successfulSelectedImage.title || "选中图片"}.png`,
      type: "image/png",
      dataUrl: src,
    });
    setReversePromptResult("");
  }, [successfulSelectedImage]);

  const runReversePrompt = useCallback(async () => {
    if (!reversePromptImage) {
      toast.error("请先上传图片");
      return;
    }
    const instruction = reversePromptInstruction.trim();
    if (!instruction) {
      toast.error("请输入反推要求");
      return;
    }
    const taskId = createImageCanvasId();
    setIsReversingPrompt(true);
    setReversePromptTaskId(taskId);
    try {
      const task = await createReversePromptTask(taskId, referenceImageToSource(reversePromptImage), instruction);
      setReversePromptTaskId(task.id || taskId);
      if (task.status === "success") {
        const prompt = reversePromptFromTask(task);
        if (!prompt) {
          throw new Error("未能从图片反推出提示词");
        }
        setReversePromptResult(prompt);
        setReversePromptTaskId(null);
        setIsReversingPrompt(false);
        toast.success("已反推出提示词");
      } else if (task.status === "error" || task.status === "cancelled") {
        throw new Error(task.error || "反推失败");
      }
    } catch (error) {
      setReversePromptTaskId(null);
      setIsReversingPrompt(false);
      toast.error(error instanceof Error ? error.message : "反推失败");
    }
  }, [reversePromptImage, reversePromptInstruction]);

  const cancelReversePrompt = useCallback(async () => {
    const taskId = reversePromptTaskId;
    if (taskId) {
      try {
        await cancelImageTasks([taskId]);
      } catch {
        // 取消请求失败时，本地先停止等待状态。
      }
    }
    setReversePromptTaskId(null);
    setIsReversingPrompt(false);
    toast.success("已取消反推");
  }, [reversePromptTaskId]);

  useEffect(() => {
    if (!reversePromptTaskId) return;
    const poll = async () => {
      try {
        const data = await fetchImageTasks([reversePromptTaskId]);
        const task = data.items.find((item) => item.id === reversePromptTaskId);
        if (!task) return;
        if (task.status === "success") {
          const prompt = reversePromptFromTask(task);
          if (prompt) {
            setReversePromptResult(prompt);
            toast.success("已反推出提示词");
          } else {
            toast.error("未能从图片反推出提示词");
          }
          setReversePromptTaskId(null);
          setIsReversingPrompt(false);
        } else if (task.status === "error" || task.status === "cancelled") {
          if (task.status === "cancelled") {
            toast.success("已取消反推");
          } else {
            toast.error(task.error || "反推失败");
          }
          setReversePromptTaskId(null);
          setIsReversingPrompt(false);
        } else {
          setIsReversingPrompt(true);
        }
      } catch {
        // 下一次轮询继续同步。
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [reversePromptTaskId]);

  const saveReversePromptInstruction = useCallback(async () => {
    if (!isAdmin) {
      toast.error("只有管理员可以保存全局要求");
      return;
    }
    const instruction = reversePromptInstruction.trim();
    if (!instruction) {
      toast.error("请输入反推要求");
      return;
    }
    setIsSavingReversePromptInstruction(true);
    try {
      const data = await updateReversePromptInstruction(instruction);
      setReversePromptInstruction(data.instruction || DEFAULT_REVERSE_PROMPT_INSTRUCTION);
      toast.success("反推要求已保存为全局设置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存反推要求失败");
    } finally {
      setIsSavingReversePromptInstruction(false);
    }
  }, [isAdmin, reversePromptInstruction]);

  const copyReversePromptResult = useCallback(async () => {
    if (!reversePromptResult.trim()) return;
    await navigator.clipboard.writeText(reversePromptResult.trim());
    toast.success("已复制提示词");
  }, [reversePromptResult]);

  const fillComposerWithReversePrompt = useCallback(() => {
    const prompt = reversePromptResult.trim();
    if (!prompt) return;
    setSelectedNodeId(null);
    setReferenceImages([]);
    setPromptDraft(prompt);
    if (composerFileInputRef.current) {
      composerFileInputRef.current.value = "";
    }
    window.setTimeout(() => composerTextareaRef.current?.focus(), 0);
    toast.success("已填入底部输入框");
  }, [reversePromptResult]);

  const openImageLightbox = useCallback(
    (nodeId: string) => {
      const index = projectLightboxImages.findIndex((image) => image.id === nodeId);
      if (index < 0) return;
      setLightboxImages(projectLightboxImages);
      setLightboxIndex(index);
      setLightboxOpen(true);
    },
    [projectLightboxImages],
  );

  const createGenerationNodes = useCallback(async () => {
    const prompt = promptDraft.trim();
    if (!prompt) {
      toast.error("请输入提示词");
      return;
    }
    const project = activeProjectRef.current;
    if (!project) return;
    const now = new Date().toISOString();
    const count = Number(clampCount(countDraft));
    const anchor = getCanvasPoint();
    const promptOrigin = findNonOverlappingCanvasPosition(
      project.nodes,
      { x: anchor.x - 500, y: anchor.y - 120 },
      (placement) => generationBranchRects(placement, count),
    );
    const promptNodeId = createImageCanvasId();
    const promptNode: ImageCanvasNode = {
      id: promptNodeId,
      type: "prompt",
      x: promptOrigin.x,
      y: promptOrigin.y,
      ...nodeSize.prompt,
      title: "提示词",
      prompt,
      model: "gpt-image-2",
      size: sizeDraft,
      count,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    const imageNodes: ImageCanvasNode[] = Array.from({ length: count }, (_, index) => {
      const id = createImageCanvasId();
      return {
        id,
        type: "image",
        x: promptNode.x + GENERATION_RESULT_X_OFFSET,
        y: promptNode.y + index * GENERATION_RESULT_Y_STEP,
        ...nodeSize.image,
        title: count > 1 ? `生成结果 ${index + 1}` : "生成结果",
        prompt,
        model: "gpt-image-2",
        size: sizeDraft,
        sourceNodeId: promptNodeId,
        taskId: id,
        status: "queued",
        progress: 0,
        progressMessage: "排队中",
        createdAt: now,
        updatedAt: now,
      };
    });
    const edges: ImageCanvasEdge[] = imageNodes.map((node) => ({
      id: createImageCanvasId(),
      from: promptNodeId,
      to: node.id,
    }));
    const nextTitle = project.nodes.length === 0 && project.title === "我的画布" ? buildProjectTitle(prompt) : project.title;
    await persistProject({
      ...project,
      title: nextTitle,
      nodes: [...project.nodes, promptNode, ...imageNodes],
      edges: [...project.edges, ...edges],
    });
    setSelectedNodeId(promptNodeId);
    clearComposerInputs();
    toast.success("已把提示词和结果节点放到画布");

    void (async () => {
      await Promise.all(
        imageNodes.map(async (node) => {
          try {
            const task = await createImageGenerationTask(node.id, prompt, "gpt-image-2", sizeDraft);
            await patchImageNode(node.id, taskToImageNode(node, task));
          } catch (error) {
            await patchImageNode(node.id, {
              status: "error",
              progress: 100,
              progressMessage: "失败",
              error: error instanceof Error ? error.message : "创建图片任务失败",
            });
          }
        }),
      );
      void syncImageTasks();
      void loadQuota();
    })();
  }, [clearComposerInputs, countDraft, getCanvasPoint, loadQuota, patchImageNode, persistProject, promptDraft, sizeDraft, syncImageTasks]);

  const createEditBranch = useCallback(async () => {
    if (!successfulSelectedImage && referenceImages.length === 0) {
      toast.error("请先选中一张已完成的图片，或上传参考图");
      return;
    }
    const prompt = promptDraft.trim();
    if (!prompt) {
      toast.error("请输入编辑要求");
      return;
    }
    const project = activeProjectRef.current;
    if (!project) return;
    const now = new Date().toISOString();
    const count = Number(clampCount(countDraft));
    const anchor = getCanvasPoint();
    const uploadedGap = 32;
    const resultGap = 32;
    const selectedSource = successfulSelectedImage ? imageNodeToSource(successfulSelectedImage) : null;
    const uploadedTotalWidth = referenceImages.length * nodeSize.image.width + Math.max(0, referenceImages.length - 1) * uploadedGap;
    const editPlacement = successfulSelectedImage
      ? null
      : findNonOverlappingCanvasPosition(
          project.nodes,
          { x: anchor.x - nodeSize.edit.width / 2, y: anchor.y - 44 },
          (placement) => {
            const referenceBaseX = placement.x + nodeSize.edit.width / 2 - uploadedTotalWidth / 2;
            const resultBaseX = placement.x - ((count - 1) * (nodeSize.image.width + resultGap)) / 2;
            return [
              ...referenceImages.map((_, index) => ({
                x: referenceBaseX + index * (nodeSize.image.width + uploadedGap),
                y: placement.y - nodeSize.image.height - 96,
                width: nodeSize.image.width,
                height: nodeSize.image.height,
              })),
              {
                x: placement.x,
                y: placement.y,
                width: nodeSize.edit.width,
                height: nodeSize.edit.height,
              },
              ...Array.from({ length: count }, (_, index) => ({
                x: resultBaseX + index * (nodeSize.image.width + resultGap),
                y: placement.y + nodeSize.edit.height + 86,
                width: nodeSize.image.width,
                height: nodeSize.image.height,
              })),
            ];
          },
        );
    const uploadedReferenceNodes: ImageCanvasNode[] = referenceImages.map((image, index) => {
      const id = createImageCanvasId();
      const baseX = successfulSelectedImage
        ? successfulSelectedImage.x + successfulSelectedImage.width + 52
        : (editPlacement?.x ?? anchor.x) + nodeSize.edit.width / 2 - uploadedTotalWidth / 2;
      return {
        id,
        type: "image",
        x: baseX + index * (nodeSize.image.width + uploadedGap),
        y: successfulSelectedImage ? successfulSelectedImage.y : (editPlacement?.y ?? anchor.y) - nodeSize.image.height - 96,
        ...nodeSize.image,
        title: referenceImages.length > 1 ? `参考图 ${index + 1}` : "参考图",
        prompt,
        model: "gpt-image-2",
        size: sizeDraft,
        status: "success",
        url: image.dataUrl,
        createdAt: now,
        updatedAt: now,
      };
    });
    const visualSourceNodes = [
      ...(successfulSelectedImage ? [successfulSelectedImage] : []),
      ...uploadedReferenceNodes,
    ];
    const sourceBounds = getCanvasBounds(visualSourceNodes);
    const editNodeId = createImageCanvasId();
    const editNode: ImageCanvasNode = {
      id: editNodeId,
      type: "edit",
      x: sourceBounds ? sourceBounds.minX + sourceBounds.width / 2 - nodeSize.edit.width / 2 : anchor.x - nodeSize.edit.width / 2,
      y: sourceBounds ? sourceBounds.maxY + 96 : anchor.y,
      ...nodeSize.edit,
      title: "编辑要求",
      prompt,
      model: "gpt-image-2",
      size: sizeDraft,
      sourceNodeId: visualSourceNodes[0]?.id,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    const resultBaseX = editNode.x - ((count - 1) * (nodeSize.image.width + resultGap)) / 2;
    const resultNodes: ImageCanvasNode[] = Array.from({ length: count }, (_, index) => {
      const resultNodeId = createImageCanvasId();
      return {
        id: resultNodeId,
        type: "image",
        x: resultBaseX + index * (nodeSize.image.width + resultGap),
        y: editNode.y + editNode.height + 86,
        ...nodeSize.image,
        title: count > 1 ? `编辑结果 ${index + 1}` : "编辑结果",
        prompt,
        model: "gpt-image-2",
        size: sizeDraft,
        sourceNodeId: editNodeId,
        taskId: resultNodeId,
        status: "queued",
        progress: 0,
        progressMessage: "排队中",
        createdAt: now,
        updatedAt: now,
      };
    });
    const sourceObjects = [
      ...(selectedSource ? [selectedSource] : []),
      ...referenceImages.map(referenceImageToSource),
    ];
    if (sourceObjects.length === 0) {
      toast.error("这张图片没有可编辑的数据");
      return;
    }
    await persistProject({
      ...project,
      nodes: [...project.nodes, ...uploadedReferenceNodes, editNode, ...resultNodes],
      edges: [
        ...project.edges,
        ...visualSourceNodes.map((node) => ({ id: createImageCanvasId(), from: node.id, to: editNodeId })),
        ...resultNodes.map((node) => ({ id: createImageCanvasId(), from: editNodeId, to: node.id })),
      ],
    });
    setSelectedNodeId(resultNodes[0]?.id ?? editNodeId);
    clearComposerInputs();
    toast.success(count > 1 ? `已创建 ${count} 张编辑分支` : "已创建编辑分支");

    void (async () => {
      await Promise.all(
        resultNodes.map(async (node) => {
          try {
            const task =
              sourceObjects.length === 1
                ? await createImageEditTaskFromSource(node.id, sourceObjects[0], prompt, "gpt-image-2", sizeDraft)
                : await createImageEditTaskFromSources(node.id, sourceObjects, prompt, "gpt-image-2", sizeDraft);
            await patchImageNode(node.id, taskToImageNode(node, task));
          } catch (error) {
            await patchImageNode(node.id, {
              status: "error",
              progress: 100,
              progressMessage: "失败",
              error: error instanceof Error ? error.message : "创建编辑任务失败",
            });
          }
        }),
      );
      void syncImageTasks();
      void loadQuota();
    })();
  }, [clearComposerInputs, countDraft, getCanvasPoint, loadQuota, patchImageNode, persistProject, promptDraft, referenceImages, sizeDraft, successfulSelectedImage, syncImageTasks]);

  const copySelectedEditNodeRevision = useCallback(async () => {
    if (!selectedEditNode) return;
    const prompt = promptDraft.trim();
    if (!prompt) {
      toast.error("请输入编辑要求");
      return;
    }
    const project = activeProjectRef.current;
    if (!project) return;

    const now = new Date().toISOString();
    const count = Number(clampCount(countDraft));
    const parentIds = project.edges.filter((edge) => edge.to === selectedEditNode.id).map((edge) => edge.from);
    const parentImageNodes = parentIds
      .map((id) => project.nodes.find((node) => node.id === id))
      .filter((node): node is ImageCanvasNode => Boolean(node && node.type === "image"));
    const parentSources = parentImageNodes.flatMap((node) => {
      const source = imageNodeToSource(node);
      return source ? [source] : [];
    });

    const sourceObjects = [...parentSources, ...referenceImages.map(referenceImageToSource)];
    if (sourceObjects.length === 0) {
      toast.error("这个编辑节点没有可用的上游图片");
      return;
    }

    const existingChildren = project.edges
      .filter((edge) => edge.from === selectedEditNode.id)
      .map((edge) => project.nodes.find((node) => node.id === edge.to))
      .filter((node): node is ImageCanvasNode => Boolean(node));
    const existingBranchBounds = getCanvasBounds([selectedEditNode, ...existingChildren]) || {
      minX: selectedEditNode.x,
      minY: selectedEditNode.y,
      maxX: selectedEditNode.x + selectedEditNode.width,
      maxY: selectedEditNode.y + selectedEditNode.height,
      width: selectedEditNode.width,
      height: selectedEditNode.height,
    };
    const copiedEditNodeId = createImageCanvasId();
    const copiedEditNode: ImageCanvasNode = {
      ...selectedEditNode,
      id: copiedEditNodeId,
      x: existingBranchBounds.maxX + 96,
      y: selectedEditNode.y,
      title: selectedEditNode.title.endsWith("副本") ? selectedEditNode.title : `${selectedEditNode.title} 副本`,
      prompt,
      size: sizeDraft,
      count,
      sourceNodeId: parentIds[0],
      createdAt: now,
      updatedAt: now,
    };
    const uploadedGap = 32;
    const uploadedReferenceNodes: ImageCanvasNode[] = referenceImages.map((image, index) => {
      const id = createImageCanvasId();
      const totalWidth = referenceImages.length * nodeSize.image.width + Math.max(0, referenceImages.length - 1) * uploadedGap;
      const baseX = copiedEditNode.x + copiedEditNode.width / 2 - totalWidth / 2;
      return {
        id,
        type: "image",
        x: baseX + index * (nodeSize.image.width + uploadedGap),
        y: copiedEditNode.y - nodeSize.image.height - 86,
        ...nodeSize.image,
        title: referenceImages.length > 1 ? `补充参考图 ${index + 1}` : "补充参考图",
        prompt,
        model: "gpt-image-2",
        size: sizeDraft,
        status: "success",
        url: image.dataUrl,
        createdAt: now,
        updatedAt: now,
      };
    });
    const resultGap = 32;
    const resultBaseX = copiedEditNode.x - ((count - 1) * (nodeSize.image.width + resultGap)) / 2;
    const resultY = copiedEditNode.y + copiedEditNode.height + 86;
    const resultNodes: ImageCanvasNode[] = Array.from({ length: count }, (_, index) => {
      const resultNodeId = createImageCanvasId();
      return {
        id: resultNodeId,
        type: "image",
        x: resultBaseX + index * (nodeSize.image.width + resultGap),
        y: resultY,
        ...nodeSize.image,
        title: count > 1 ? `编辑结果 ${index + 1}` : "编辑结果",
        prompt,
        model: "gpt-image-2",
        size: sizeDraft,
        sourceNodeId: copiedEditNodeId,
        taskId: resultNodeId,
        status: "queued",
        progress: 0,
        progressMessage: "排队中",
        createdAt: now,
        updatedAt: now,
      };
    });

    await persistProject({
      ...project,
      nodes: [
        ...project.nodes,
        ...uploadedReferenceNodes,
        copiedEditNode,
        ...resultNodes,
      ],
      edges: [
        ...project.edges,
        ...parentIds.map((parentId) => ({ id: createImageCanvasId(), from: parentId, to: copiedEditNodeId })),
        ...uploadedReferenceNodes.map((node) => ({ id: createImageCanvasId(), from: node.id, to: copiedEditNodeId })),
        ...resultNodes.map((node) => ({ id: createImageCanvasId(), from: copiedEditNodeId, to: node.id })),
      ],
    });
    setSelectedNodeId(resultNodes[0]?.id ?? copiedEditNodeId);
    clearComposerInputs();
    toast.success(count > 1 ? `已复制编辑节点并生成 ${count} 张新结果` : "已复制编辑节点并生成新结果");

    void (async () => {
      await Promise.all(
        resultNodes.map(async (node) => {
          try {
            const task =
              sourceObjects.length === 1
                ? await createImageEditTaskFromSource(node.id, sourceObjects[0], prompt, "gpt-image-2", sizeDraft)
                : await createImageEditTaskFromSources(node.id, sourceObjects, prompt, "gpt-image-2", sizeDraft);
            await patchImageNode(node.id, taskToImageNode(node, task));
          } catch (error) {
            await patchImageNode(node.id, {
              status: "error",
              progress: 100,
              progressMessage: "失败",
              error: error instanceof Error ? error.message : "创建编辑任务失败",
            });
          }
        }),
      );
      void syncImageTasks();
      void loadQuota();
    })();
  }, [clearComposerInputs, countDraft, loadQuota, patchImageNode, persistProject, promptDraft, referenceImages, selectedEditNode, sizeDraft, syncImageTasks]);

  const handleComposerSubmit = useCallback(async () => {
    if (selectedEditNode) {
      await copySelectedEditNodeRevision();
      return;
    }
    if (successfulSelectedImage || referenceImages.length > 0) {
      await createEditBranch();
      return;
    }
    await createGenerationNodes();
  }, [copySelectedEditNodeRevision, createEditBranch, createGenerationNodes, referenceImages.length, selectedEditNode, successfulSelectedImage]);

  const clearEditSelection = useCallback(() => {
    setSelectedNodeId(null);
    clearComposerInputs();
  }, [clearComposerInputs]);

  const cancelNodeTask = useCallback(
    async (node: ImageCanvasNode) => {
      if (!node.taskId) return;
      await patchImageNode(node.id, { status: "cancelled", progress: 100, progressMessage: "已取消", error: "任务已取消" });
      try {
        await cancelImageTasks([node.taskId]);
        toast.success("已取消任务");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "取消失败");
      }
    },
    [patchImageNode],
  );

  const retryImageNode = useCallback(
    async (node: ImageCanvasNode) => {
      if (node.type !== "image") return;
      const project = activeProjectRef.current;
      if (!project) return;
      const sourceNode = project.nodes.find((item) => item.id === node.sourceNodeId);
      if (!sourceNode) {
        await patchImageNode(node.id, { status: "error", progress: 100, progressMessage: "失败", error: "找不到来源节点" });
        return;
      }

      const taskId = createImageCanvasId();
      const queuedNode: ImageCanvasNode = {
        ...node,
        taskId,
        status: "queued",
        progress: 0,
        progressMessage: "排队中",
        error: undefined,
        b64_json: undefined,
        url: undefined,
        revised_prompt: undefined,
        updatedAt: new Date().toISOString(),
      };
      await patchImageNode(node.id, queuedNode);

      try {
        if (sourceNode.type === "prompt") {
          const task = await createImageGenerationTask(
            taskId,
            sourceNode.prompt || node.prompt || "",
            sourceNode.model || node.model || "gpt-image-2",
            sourceNode.size ?? node.size,
          );
          await patchImageNode(node.id, taskToImageNode(queuedNode, task));
          void syncImageTasks();
          return;
        }

        if (sourceNode.type === "edit") {
          const parentIds = project.edges.filter((edge) => edge.to === sourceNode.id).map((edge) => edge.from);
          const sourceImages = parentIds
            .map((id) => project.nodes.find((item) => item.id === id))
            .filter((item): item is ImageCanvasNode => Boolean(item && item.type === "image"));
          if (sourceImages.length === 0) {
            throw new Error("找不到原始图片");
          }
          const imageSources = sourceImages.flatMap((image) => {
            const source = imageNodeToSource(image);
            return source ? [source] : [];
          });
          if (imageSources.length === 0) {
            throw new Error("这张图片没有可编辑的数据");
          }
          const task =
            imageSources.length === 1
              ? await createImageEditTaskFromSource(
                  taskId,
                  imageSources[0],
                  sourceNode.prompt || node.prompt || "",
                  sourceNode.model || node.model || "gpt-image-2",
                  sourceNode.size ?? node.size,
                )
              : await createImageEditTaskFromSources(
                  taskId,
                  imageSources,
                  sourceNode.prompt || node.prompt || "",
                  sourceNode.model || node.model || "gpt-image-2",
                  sourceNode.size ?? node.size,
                );
          await patchImageNode(node.id, taskToImageNode(queuedNode, task));
          void syncImageTasks();
          return;
        }

        throw new Error("不支持重试这个节点");
      } catch (error) {
        await patchImageNode(node.id, {
          status: "error",
          progress: 100,
          progressMessage: "失败",
          error: error instanceof Error ? error.message : "重试失败",
        });
      }
    },
    [patchImageNode, syncImageTasks],
  );

  const deleteNode = useCallback(async (nodeId: string) => {
    await updateActiveProject((project) => ({
      ...project,
      nodes: project.nodes.filter((item) => item.id !== nodeId),
      edges: project.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
    setSelectedNodeId((current) => (current === nodeId ? null : current));
    setCompareNodeIds((current) => current.filter((id) => id !== nodeId));
  }, [updateActiveProject]);

  const deleteSelectedNode = useCallback(async () => {
    if (!selectedNode) return;
    await deleteNode(selectedNode.id);
  }, [deleteNode, selectedNode]);

  const copyImageNode = useCallback(
    async (node: ImageCanvasNode) => {
      if (node.type !== "image" || node.status !== "success") return;
      const project = activeProjectRef.current;
      if (!project) return;
      const now = new Date().toISOString();
      const copiedNodeId = createImageCanvasId();
      const sourceNodeExists = Boolean(node.sourceNodeId && project.nodes.some((item) => item.id === node.sourceNodeId));
      const copiedNode: ImageCanvasNode = {
        ...node,
        id: copiedNodeId,
        taskId: undefined,
        x: node.x + node.width + 36,
        y: node.y + 28,
        title: node.title.endsWith("副本") ? node.title : `${node.title} 副本`,
        createdAt: now,
        updatedAt: now,
      };
      await persistProject({
        ...project,
        nodes: [...project.nodes, copiedNode],
        edges: sourceNodeExists && node.sourceNodeId
          ? [...project.edges, { id: createImageCanvasId(), from: node.sourceNodeId, to: copiedNodeId }]
          : project.edges,
      });
      setSelectedNodeId(copiedNodeId);
      toast.success("已复制图片节点");
    },
    [persistProject],
  );

  const toggleNodeFavorite = useCallback(
    async (node: ImageCanvasNode) => {
      await patchImageNode(node.id, { favorite: !node.favorite });
    },
    [patchImageNode],
  );

  const toggleCompareNode = useCallback((node: ImageCanvasNode) => {
    if (node.type !== "image" || node.status !== "success" || !getImageNodeSrc(node)) return;
    setCompareNodeIds((current) => {
      if (current.includes(node.id)) {
        return current.filter((id) => id !== node.id);
      }
      return [...current, node.id].slice(-2);
    });
  }, []);

  const exportActiveProject = useCallback(() => {
    const project = activeProjectRef.current;
    if (!project) return;
    downloadJsonFile(`${safeFileName(project.title, "canvas-project")}.json`, {
      type: "chatgpt2api.image_canvas_project",
      version: 1,
      exportedAt: new Date().toISOString(),
      project,
    });
    toast.success("画布项目已导出");
  }, []);

  const createProject = useCallback(async () => {
    const project = createBlankImageCanvasProject(`画布 ${projects.length + 1}`);
    setProjects((current) => [project, ...current]);
    setActiveProjectId(project.id);
    setSelectedNodeId(null);
    await saveImageCanvasProject(project);
    toast.success("已新建画布");
  }, [projects.length]);

  const confirmDeleteProject = useCallback(async () => {
    if (!deleteProjectTarget) return;

    await deleteImageCanvasProject(deleteProjectTarget.id);
    let nextProjects = projects.filter((project) => project.id !== deleteProjectTarget.id);
    if (nextProjects.length === 0) {
      const blankProject = createBlankImageCanvasProject("我的画布");
      await saveImageCanvasProject(blankProject);
      nextProjects = [blankProject];
    }

    const nextActiveProjectId = activeProjectId === deleteProjectTarget.id ? nextProjects[0]?.id ?? null : activeProjectId;
    setProjects(nextProjects);
    setActiveProjectId(nextActiveProjectId);
    setSelectedNodeId(null);
    setDeleteProjectTarget(null);
    if (typeof window !== "undefined") {
      if (nextActiveProjectId) {
        window.localStorage.setItem(ACTIVE_PROJECT_KEY, nextActiveProjectId);
      } else {
        window.localStorage.removeItem(ACTIVE_PROJECT_KEY);
      }
    }
    toast.success("画布已删除");
  }, [activeProjectId, deleteProjectTarget, projects]);

  const updateViewport = useCallback(
    async (viewport: ImageCanvasViewport) => {
      await updateActiveProject((project) => ({
        ...project,
        viewport,
      }));
    },
    [updateActiveProject],
  );

  const focusCanvasNode = useCallback(
    async (nodeId: string) => {
      const project = activeProjectRef.current;
      const node = project?.nodes.find((item) => item.id === nodeId);
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!project || !node || !rect) return;
      const zoom = clamp(project.viewport.zoom, 0.55, 1.12);
      setSelectedNodeId(node.id);
      await updateViewport({
        x: rect.width / 2 - (node.x + node.width / 2) * zoom,
        y: rect.height / 2 - (node.y + node.height / 2) * zoom,
        zoom,
      });
    },
    [updateViewport],
  );

  const fitCanvasToNodes = useCallback(async () => {
    const project = activeProjectRef.current;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!project || !rect) return;
    const bounds = getCanvasBounds(project.nodes);
    if (!bounds) return;
    await updateViewport(viewportForBounds(bounds, rect.width, rect.height));
  }, [updateViewport]);

  const focusSelectedNode = useCallback(async () => {
    if (!selectedNodeId) return;
    await focusCanvasNode(selectedNodeId);
  }, [focusCanvasNode, selectedNodeId]);

  const tidyCanvasLayout = useCallback(async () => {
    const project = activeProjectRef.current;
    if (!project || project.nodes.length === 0) return;
    const nextProject = await persistProject({
      ...project,
      nodes: layoutCanvasNodes(project.nodes, project.edges),
    });
    if (selectedNodeId && nextProject?.nodes.some((node) => node.id === selectedNodeId)) {
      await focusCanvasNode(selectedNodeId);
    } else {
      await fitCanvasToNodes();
    }
    toast.success("画布分支已整理");
  }, [fitCanvasToNodes, focusCanvasNode, persistProject, selectedNodeId]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      const project = activeProjectRef.current;
      if (!project) return;
      event.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const zoom = clamp(project.viewport.zoom - event.deltaY * 0.001, 0.35, 1.8);
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const worldX = (mouseX - project.viewport.x) / project.viewport.zoom;
      const worldY = (mouseY - project.viewport.y) / project.viewport.zoom;
      void updateViewport({
        x: mouseX - worldX * zoom,
        y: mouseY - worldY * zoom,
        zoom,
      });
    },
    [updateViewport],
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("[data-canvas-node='true']")) return;
      const project = activeProjectRef.current;
      if (!project) return;
      setSelectedNodeId(null);
      if (selectedEditNode) {
        clearComposerInputs();
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStateRef.current = {
        type: "pan",
        startX: event.clientX,
        startY: event.clientY,
        baseViewport: project.viewport,
      };
    },
    [clearComposerInputs, selectedEditNode],
  );

  const handleNodePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, node: ImageCanvasNode) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const zoom = activeProjectRef.current?.viewport.zoom ?? 1;
    dragStateRef.current = {
      type: "node",
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      baseX: node.x,
      baseY: node.y,
      zoom,
    };
    setSelectedNodeId(node.id);
  }, []);

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement | HTMLElement>) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;
      if (dragState.type === "pan") {
        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;
        const project = activeProjectRef.current;
        if (project) {
          applyLocalProject({
            ...project,
            viewport: {
              ...dragState.baseViewport,
              x: dragState.baseViewport.x + dx,
              y: dragState.baseViewport.y + dy,
            },
          });
        }
        return;
      }
      const dx = (event.clientX - dragState.startX) / dragState.zoom;
      const dy = (event.clientY - dragState.startY) / dragState.zoom;
      const project = activeProjectRef.current;
      if (!project) return;
      applyLocalProject({
        ...project,
        nodes: project.nodes.map((node) =>
          node.id === dragState.nodeId
            ? {
                ...node,
                x: dragState.baseX + dx,
                y: dragState.baseY + dy,
                updatedAt: new Date().toISOString(),
              }
            : node,
        ),
      });
    },
    [applyLocalProject],
  );

  const handlePointerUp = useCallback(() => {
    const hadDragState = Boolean(dragStateRef.current);
    dragStateRef.current = null;
    const project = activeProjectRef.current;
    if (hadDragState && project) {
      void persistProject(project);
    }
  }, [persistProject]);

  const zoomBy = useCallback(
    (delta: number) => {
      const project = activeProjectRef.current;
      if (!project) return;
      void updateViewport({ ...project.viewport, zoom: clamp(project.viewport.zoom + delta, 0.35, 1.8) });
    },
    [updateViewport],
  );

  if (isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  if (!activeProject) {
    return null;
  }

  const nodeMap = new Map(activeProject.nodes.map((node) => [node.id, node]));
  const upstreamHighlight = getSelectedUpstreamHighlight(activeProject, selectedNodeId);
  const canvasNodeList = [...activeProject.nodes].sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.y - b.y || a.x - b.x);

  return (
    <>
    <section className="mx-auto grid h-[calc(100dvh-5.5rem)] min-h-0 w-full max-w-[1700px] grid-cols-1 overflow-hidden px-2 pb-3 sm:h-[calc(100dvh-4rem)] sm:px-4 xl:grid-cols-[260px_minmax(0,1fr)_320px] xl:gap-3">
      <aside className="hidden min-h-0 flex-col overflow-hidden border-r border-stone-200/70 pr-3 xl:flex">
        <div className="flex items-center justify-between gap-2 py-3">
          <div>
            <h1 className="text-base font-semibold tracking-tight text-stone-950">画布创作</h1>
            <p className="text-xs text-stone-500">提示词、结果和编辑分支会自动保存</p>
          </div>
          <Button className="h-9 rounded-xl bg-stone-950 px-3 text-white" onClick={() => void createProject()}>
            <Plus className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-4">
          <div className="rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
            <input
              ref={reversePromptFileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void setReversePromptImageFromFile(event.target.files?.[0]);
              }}
            />
            <div className="mb-3 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-stone-900">反推提示词</div>
              {isReversingPrompt ? <LoaderCircle className="size-4 animate-spin text-stone-400" /> : null}
            </div>

            {reversePromptImage ? (
              <div className="relative overflow-hidden rounded-2xl border border-stone-200 bg-stone-50">
                <img src={reversePromptImage.dataUrl} alt={reversePromptImage.name || "反推图片"} className="h-32 w-full object-contain" />
                <button
                  type="button"
                  className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full border border-stone-200 bg-white/95 text-stone-500 shadow-sm transition hover:text-stone-900"
                  aria-label="移除反推图片"
                  onClick={clearReversePromptImage}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="flex h-32 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-stone-300 bg-stone-50 text-sm font-medium text-stone-500 transition hover:border-stone-400 hover:bg-white hover:text-stone-800"
                onClick={() => reversePromptFileInputRef.current?.click()}
              >
                <ImagePlus className="size-5" />
                上传图片
              </button>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-xl border-stone-200 bg-white px-2 text-xs"
                onClick={() => reversePromptFileInputRef.current?.click()}
                disabled={isReversingPrompt}
              >
                上传
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-xl border-stone-200 bg-white px-2 text-xs"
                onClick={useSelectedImageForReversePrompt}
                disabled={!successfulSelectedImage || isReversingPrompt}
              >
                用当前图
              </Button>
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-semibold text-stone-500">反推要求</div>
                {isLoadingReversePromptInstruction ? <LoaderCircle className="size-3.5 animate-spin text-stone-400" /> : null}
              </div>
              <Textarea
                value={reversePromptInstruction}
                onChange={(event) => setReversePromptInstruction(event.target.value)}
                disabled={isReversingPrompt || isLoadingReversePromptInstruction}
                className="min-h-24 max-h-40 resize-none rounded-2xl border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 shadow-none placeholder:text-stone-400 focus-visible:ring-2"
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 rounded-xl border-stone-200 bg-white px-2 text-xs"
                  onClick={() => setReversePromptInstruction(DEFAULT_REVERSE_PROMPT_INSTRUCTION)}
                  disabled={isReversingPrompt || isLoadingReversePromptInstruction || reversePromptInstruction === DEFAULT_REVERSE_PROMPT_INSTRUCTION}
                >
                  恢复默认
                </Button>
                {isAdmin ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-xl border-stone-200 bg-white px-2 text-xs"
                    onClick={() => void saveReversePromptInstruction()}
                    disabled={isReversingPrompt || isLoadingReversePromptInstruction || isSavingReversePromptInstruction || !reversePromptInstruction.trim()}
                  >
                    {isSavingReversePromptInstruction ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                    保存要求
                  </Button>
                ) : null}
              </div>
            </div>

            <div className={cn("mt-2 grid gap-2", isReversingPrompt ? "grid-cols-[1fr_auto]" : "grid-cols-1")}>
              <Button
                type="button"
                className="h-9 rounded-xl bg-stone-950 text-xs text-white hover:bg-stone-800"
                onClick={() => void runReversePrompt()}
                disabled={!reversePromptImage || isReversingPrompt || isLoadingReversePromptInstruction}
              >
                {isReversingPrompt ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {isReversingPrompt ? "反推中" : "反推提示词"}
              </Button>
              {isReversingPrompt ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-xl border-rose-200 bg-white px-3 text-xs text-rose-700 hover:bg-rose-50"
                  onClick={cancelReversePrompt}
                >
                  <X className="size-3.5" />
                  取消
                </Button>
              ) : null}
            </div>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="text-xs font-semibold text-stone-500">反推结果</div>
                {reversePromptResult ? <span className="text-[11px] text-stone-400">{reversePromptResult.length} 字</span> : null}
              </div>
              <Textarea
                value={reversePromptResult}
                onChange={(event) => setReversePromptResult(event.target.value)}
                placeholder={isReversingPrompt ? "正在反推，结果会显示在这里" : "结果会显示在这里，也可以手动粘贴提示词"}
                className="min-h-32 max-h-56 resize-none rounded-2xl border-stone-200 bg-stone-50 px-3 py-2 text-xs leading-5 shadow-none placeholder:text-stone-400 focus-visible:ring-2"
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-xl border-stone-200 bg-white px-2 text-xs"
                  onClick={() => void copyReversePromptResult()}
                  disabled={!reversePromptResult.trim()}
                >
                  <Copy className="size-3.5" />
                  复制
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-xl border-stone-200 bg-white px-2 text-xs"
                  onClick={fillComposerWithReversePrompt}
                  disabled={!reversePromptResult.trim()}
                >
                  填入底部
                </Button>
              </div>
            </div>
          </div>

          <div className="mb-2 mt-4 flex items-center justify-between gap-2 px-1">
            <div className="text-xs font-semibold text-stone-500">画布列表</div>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">{projects.length}</span>
          </div>
          <div className="space-y-2">
            {projects.map((project) => (
              <div
                key={project.id}
                className={cn(
                  "group flex w-full items-center gap-2 rounded-2xl border px-3 py-3 text-left transition",
                  project.id === activeProject.id
                    ? "border-stone-900 bg-stone-950 text-white"
                    : "border-stone-200 bg-white text-stone-700 hover:border-stone-300",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setSelectedNodeId(null);
                  }}
                >
                <span className="block truncate text-sm font-semibold">{project.title}</span>
                <span className={cn("mt-1 block text-xs", project.id === activeProject.id ? "text-stone-300" : "text-stone-400")}>
                  {project.nodes.length} 节点 · {formatTime(project.updatedAt)}
                </span>
                </button>
                <button
                  type="button"
                  className={cn(
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-xl transition",
                    project.id === activeProject.id
                      ? "text-stone-300 hover:bg-white/10 hover:text-white"
                      : "text-stone-400 hover:bg-rose-50 hover:text-rose-600",
                  )}
                  aria-label={`删除画布 ${project.title}`}
                  title="删除画布"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteProjectTarget(project);
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="relative isolate min-h-0 overflow-hidden rounded-[24px] border border-stone-200 bg-[#f7f6f2]">
        <div className="pointer-events-none absolute inset-0 z-0 opacity-80 [background-image:linear-gradient(rgba(68,64,60,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(68,64,60,0.08)_1px,transparent_1px)] [background-size:28px_28px]" />
        <div className="absolute left-3 top-3 z-40 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-2">
          <div className="rounded-full border border-stone-200 bg-white/95 px-3 py-2 text-xs font-medium text-stone-600 shadow-sm">
            {saveState === "saving" ? "保存中" : "已自动保存"} · {runningCount} 个任务处理中
          </div>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => void persistProject(activeProject)}>
            <Save className="size-4" />
            保存
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={exportActiveProject} disabled={activeProject.nodes.length === 0}>
            <Download className="size-4" />
            导出
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => void tidyCanvasLayout()} disabled={activeProject.nodes.length === 0}>
            <Workflow className="size-4" />
            整理
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => void fitCanvasToNodes()} disabled={activeProject.nodes.length === 0}>
            <Maximize2 className="size-4" />
            适配
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => void focusSelectedNode()} disabled={!selectedNode}>
            <LocateFixed className="size-4" />
            定位
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => zoomBy(-0.12)}>
            <ZoomOut className="size-4" />
          </Button>
          <Button variant="outline" className="h-9 rounded-full border-stone-200 bg-white/95 px-3" onClick={() => zoomBy(0.12)}>
            <ZoomIn className="size-4" />
          </Button>
        </div>

        <div className="pointer-events-auto absolute inset-x-3 bottom-3 z-50">
          {selectedEditNode ? (
            <div className="mx-auto mb-2 flex w-[min(980px,100%)] items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50/95 px-3 py-2 text-xs text-amber-800 shadow-sm">
              <span className="min-w-0 truncate">正在复制这个编辑要求节点，会保留它的上游图片并在副本下方生成新结果</span>
              <button
                type="button"
                className="shrink-0 rounded-full px-2 py-1 text-amber-700 transition hover:bg-white hover:text-amber-950"
                onClick={clearEditSelection}
              >
                取消选择
              </button>
            </div>
          ) : successfulSelectedImage ? (
            <div className="mx-auto mb-2 flex w-[min(980px,100%)] items-center justify-between gap-2 rounded-2xl border border-stone-200 bg-white/95 px-3 py-2 text-xs text-stone-600 shadow-sm">
              <span className="min-w-0 truncate">正在基于选中的图片继续编辑</span>
              <button
                type="button"
                className="shrink-0 rounded-full px-2 py-1 text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
                onClick={() => setSelectedNodeId(null)}
              >
                取消选择
              </button>
            </div>
          ) : null}
          <ImageComposer
            prompt={promptDraft}
            imageCount={countDraft}
            imageSize={sizeDraft}
            availableQuota={availableQuota}
            activeTaskCount={runningCount}
            referenceImages={referenceImages}
            textareaRef={composerTextareaRef}
            fileInputRef={composerFileInputRef}
            onPromptChange={setPromptDraft}
            onImageCountChange={(value) => setCountDraft(value ? clampCount(value) : "")}
            onImageSizeChange={setSizeDraft}
            onSubmit={handleComposerSubmit}
            onPickReferenceImage={() => composerFileInputRef.current?.click()}
            onReferenceImageChange={appendReferenceImages}
            onRemoveReferenceImage={handleRemoveReferenceImage}
            placeholder={
              selectedEditNode
                ? "修改这个编辑要求，提交后会复制节点并基于同一批上游图片生成结果"
                : successfulSelectedImage || referenceImages.length > 0
                  ? "描述你希望如何修改参考图"
                  : "输入你想要生成的画面，也可直接粘贴图片"
            }
            submitAriaLabel={selectedEditNode ? "复制编辑节点并生成结果" : successfulSelectedImage || referenceImages.length > 0 ? "编辑图片" : "生成图片"}
          />
        </div>

        <div
          ref={canvasRef}
          className="absolute inset-0 z-10 cursor-grab overflow-hidden active:cursor-grabbing"
          onWheel={handleWheel}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div
            className="absolute left-0 top-0 h-[4200px] w-[5600px]"
            style={{
              transform: `translate(${activeProject.viewport.x}px, ${activeProject.viewport.y}px) scale(${activeProject.viewport.zoom})`,
              transformOrigin: "0 0",
            }}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
              {activeProject.edges.map((edge) => {
                const from = nodeMap.get(edge.from);
                const to = nodeMap.get(edge.to);
                if (!from || !to) return null;
                const visual = getEdgeVisual(edge, from, to, selectedNodeId, upstreamHighlight);
                const path = getEdgePath(from, to);
                return (
                  <g key={edge.id} opacity={visual.opacity}>
                    <path
                      d={path}
                      fill="none"
                      stroke={visual.glow}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={visual.strokeWidth + 7}
                      opacity={visual.glowOpacity}
                    />
                    <path
                      d={path}
                      fill="none"
                      stroke={visual.stroke}
                      strokeDasharray={visual.dashArray}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={visual.strokeWidth}
                    />
                  </g>
                );
              })}
            </svg>

            {activeProject.nodes.map((node) => {
              const imageSrc = node.type === "image" ? getImageNodeSrc(node) : "";
              const nodeProgress = getNodeProgress(node);
              const nodeProgressMessage = node.progressMessage || getStatusLabel(node.status);
              const isSelected = node.id === selectedNodeId;
              const isCompareSelected = compareNodeIds.includes(node.id);
              const upstreamColor = isSelected ? undefined : upstreamHighlight.nodeColors.get(node.id);
              return (
                <article
                  key={node.id}
                  data-canvas-node="true"
                  className={cn(
                    "absolute overflow-hidden rounded-[20px] border bg-white shadow-[0_18px_70px_-44px_rgba(15,23,42,0.55)] transition",
                    isSelected ? "border-stone-950 ring-4 ring-stone-950/10" : "border-stone-200",
                  )}
                  style={{
                    left: node.x,
                    top: node.y,
                    width: node.width,
                    minHeight: node.height,
                    ...(upstreamColor
                      ? {
                          borderColor: upstreamColor,
                          borderWidth: 2,
                          boxShadow: `0 0 0 3px ${upstreamHighlight.glow}, 0 18px 70px -44px rgba(15,23,42,0.55)`,
                        }
                      : {}),
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedNodeId(node.id);
                  }}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                >
                  <header
                    className="flex cursor-grab items-center justify-between gap-2 border-b border-stone-100 bg-stone-50 px-3 py-2 active:cursor-grabbing"
                    onPointerDown={(event) => handleNodePointerDown(event, node)}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {node.type === "prompt" ? <BoxSelect className="size-4 text-stone-500" /> : node.type === "edit" ? <ScissorsLineDashed className="size-4 text-stone-500" /> : <ImagePlus className="size-4 text-stone-500" />}
                      <span className="truncate text-sm font-semibold text-stone-800">{node.title}</span>
                      {node.favorite ? <Star className="size-3.5 fill-amber-400 text-amber-500" /> : null}
                    </div>
                    <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium", nodeStatusClass(node.status))}>
                      {node.status === "generating" ? <LoaderCircle className="mr-1 inline size-3 animate-spin" /> : null}
                      {getStatusLabel(node.status)}
                    </span>
                  </header>

                  {node.type === "image" ? (
                    <div className="p-3">
                      <div className="flex h-[188px] items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-stone-50">
                        {node.status === "success" && imageSrc ? (
                          <button
                            type="button"
                            className="group relative flex h-full w-full cursor-zoom-in items-center justify-center"
                            title="放大查看图片"
                            aria-label="放大查看图片"
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              setSelectedNodeId(node.id);
                              openImageLightbox(node.id);
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedNodeId(node.id);
                              openImageLightbox(node.id);
                            }}
                          >
                            <img src={imageSrc} alt={node.title} className="h-full w-full object-contain" draggable={false} />
                            <span className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-full bg-black/45 text-white opacity-0 shadow-sm transition group-hover:opacity-100">
                              <ZoomIn className="size-3.5" />
                            </span>
                          </button>
                        ) : node.status === "error" || node.status === "cancelled" ? (
                          <div className="px-4 text-center text-sm leading-6 text-rose-600">{node.error || "任务失败"}</div>
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-sm text-stone-500">
                            <LoaderCircle className="size-5 animate-spin" />
                            <span>{nodeProgressMessage}</span>
                            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white shadow-inner">
                              <div className="h-full rounded-full bg-stone-700 transition-all" style={{ width: `${nodeProgress}%` }} />
                            </div>
                            <span className="text-[11px] text-stone-400">{nodeProgress}%</span>
                          </div>
                        )}
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-stone-500">{node.size || "未指定比例"}</span>
                        <div className="flex items-center gap-1">
                          {node.status === "success" ? (
                            <>
                              <Button
                                variant="outline"
                                className={cn("h-8 rounded-full border-stone-200 px-2.5 text-xs", node.favorite ? "border-amber-200 bg-amber-50 text-amber-700" : "")}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleNodeFavorite(node);
                                }}
                              >
                                <Star className={cn("size-3.5", node.favorite ? "fill-current" : "")} />
                              </Button>
                              <Button
                                variant="outline"
                                className={cn("h-8 rounded-full border-stone-200 px-2.5 text-xs", isCompareSelected ? "border-blue-200 bg-blue-50 text-blue-700" : "")}
                                title="加入版本对比"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleCompareNode(node);
                                }}
                              >
                                <Columns2 className="size-3.5" />
                              </Button>
                              <Button variant="outline" className="h-8 rounded-full border-stone-200 px-2.5 text-xs" onClick={() => void downloadImageNode(node)}>
                                <Download className="size-3.5" />
                              </Button>
                              <Button
                                variant="outline"
                                className="h-8 rounded-full border-stone-200 px-3 text-xs"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void copyImageNode(node);
                                }}
                              >
                                <Copy className="size-3.5" />
                                复制
                              </Button>
                              <Button className="h-8 rounded-full bg-stone-950 px-3 text-xs text-white hover:bg-stone-800" onClick={() => setSelectedNodeId(node.id)}>
                                编辑
                              </Button>
                            </>
                          ) : node.status === "queued" || node.status === "generating" ? (
                            <Button variant="outline" className="h-8 rounded-full border-stone-200 px-3 text-xs" onClick={() => void cancelNodeTask(node)}>
                              <X className="size-3.5" />
                              取消
                            </Button>
                          ) : node.status === "error" || node.status === "cancelled" ? (
                            <>
                              <Button variant="outline" className="h-8 rounded-full border-stone-200 px-3 text-xs" onClick={() => void retryImageNode(node)}>
                                <RefreshCcw className="size-3.5" />
                                重试
                              </Button>
                              <Button
                                variant="outline"
                                className="h-8 rounded-full border-rose-200 px-3 text-xs text-rose-700 hover:bg-rose-50"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void deleteNode(node.id);
                                }}
                              >
                                <Trash2 className="size-3.5" />
                                删除
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 p-4">
                      <p className="line-clamp-6 whitespace-pre-wrap text-sm leading-6 text-stone-700">{node.prompt || "暂无提示词"}</p>
                      <div className="flex items-center justify-between gap-2 text-xs text-stone-400">
                        <span>{node.size || "未指定比例"}</span>
                        <span>{formatTime(node.createdAt)}</span>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </main>

      <aside className="hidden min-h-0 flex-col overflow-hidden border-l border-stone-200/70 pl-3 xl:flex">
        <div className="border-b border-stone-200/70 py-3">
          <Input
            value={activeProject.title}
            onChange={(event) => {
              const title = event.target.value;
              void updateActiveProject((project) => ({ ...project, title }));
            }}
            className="h-10 rounded-xl border-stone-200 bg-white text-sm font-semibold"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto py-3">
          {selectedNode ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-stone-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-stone-900">{selectedNode.title}</div>
                    <div className="mt-1 text-xs text-stone-500">{selectedNode.type === "image" ? "图片节点" : selectedNode.type === "edit" ? "编辑节点" : "提示词节点"}</div>
                  </div>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium", nodeStatusClass(selectedNode.status))}>
                    {getStatusLabel(selectedNode.status)}
                  </span>
                </div>
                {selectedNode.prompt ? <p className="mt-3 whitespace-pre-wrap rounded-xl bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600">{selectedNode.prompt}</p> : null}
              </div>

              <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm leading-6 text-stone-500">
                {selectedEditNode
                  ? "已选中编辑要求节点。底部可以改提示词、张数和比例，提交后会复制这个编辑节点，保留上游图片并生成新的结果。"
                  : successfulSelectedImage
                    ? "已选中这张图。直接在底部输入框写编辑要求，就会在这张图下方生成新的分支。"
                    : "选中一张已完成的图片后，底部输入框会切换为继续编辑模式。"}
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className={cn("h-9 flex-1 rounded-xl border-stone-200 bg-white", selectedNode.favorite ? "border-amber-200 bg-amber-50 text-amber-700" : "")}
                  onClick={() => void toggleNodeFavorite(selectedNode)}
                >
                  <Star className={cn("size-4", selectedNode.favorite ? "fill-current" : "")} />
                  {selectedNode.favorite ? "已收藏" : "收藏"}
                </Button>
                {selectedNode.type === "image" && selectedNode.status === "success" ? (
                  <Button variant="outline" className="h-9 flex-1 rounded-xl border-stone-200 bg-white" onClick={() => void downloadImageNode(selectedNode)}>
                    <Download className="size-4" />
                    下载
                  </Button>
                ) : null}
                {selectedNode.type === "image" && selectedNode.status === "success" ? (
                  <Button variant="outline" className="h-9 flex-1 rounded-xl border-stone-200 bg-white" onClick={() => void copyImageNode(selectedNode)}>
                    <Copy className="size-4" />
                    复制
                  </Button>
                ) : null}
                {selectedNode.type === "image" && selectedNode.status === "success" ? (
                  <Button
                    variant="outline"
                    className={cn("h-9 flex-1 rounded-xl border-stone-200 bg-white", compareNodeIds.includes(selectedNode.id) ? "border-blue-200 bg-blue-50 text-blue-700" : "")}
                    onClick={() => toggleCompareNode(selectedNode)}
                  >
                    <Columns2 className="size-4" />
                    对比
                  </Button>
                ) : null}
                <Button variant="outline" className="h-9 flex-1 rounded-xl border-rose-200 bg-white text-rose-700" onClick={() => void deleteSelectedNode()}>
                  <Trash2 className="size-4" />
                  删除节点
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-5 text-sm leading-6 text-stone-500">
              选中节点后可以查看提示词、下载图片，或从结果图继续编辑生成分支。
            </div>
          )}

          {canvasNodeList.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-stone-200 bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-stone-900">节点导航</div>
                <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500">{canvasNodeList.length}</span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
                {canvasNodeList.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition",
                      node.id === selectedNodeId
                        ? "border-stone-900 bg-stone-950 text-white"
                        : "border-transparent bg-stone-50 text-stone-700 hover:border-stone-200 hover:bg-white",
                    )}
                    onClick={() => void focusCanvasNode(node.id)}
                  >
                    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", node.id === selectedNodeId ? "bg-white/12" : "bg-white")}>
                      {node.type === "prompt" ? <BoxSelect className="size-3.5" /> : node.type === "edit" ? <ScissorsLineDashed className="size-3.5" /> : <ImagePlus className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-xs font-semibold">{node.title}</span>
                        {node.favorite ? <Star className={cn("size-3 shrink-0 fill-current", node.id === selectedNodeId ? "text-amber-300" : "text-amber-500")} /> : null}
                        <span className={cn("shrink-0 text-[10px]", node.id === selectedNodeId ? "text-stone-300" : "text-stone-400")}>{getNodeTypeLabel(node.type)}</span>
                      </span>
                      <span className={cn("mt-0.5 block truncate text-[11px]", node.id === selectedNodeId ? "text-stone-300" : "text-stone-400")}>
                        {getNodePreview(node)}
                      </span>
                    </span>
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", node.id === selectedNodeId ? "bg-white/12 text-stone-200" : "bg-white text-stone-500")}>
                      {getStatusLabel(node.status)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </aside>
    </section>

    <ImageLightbox
      images={lightboxImages}
      currentIndex={lightboxIndex}
      open={lightboxOpen}
      onOpenChange={setLightboxOpen}
      onIndexChange={setLightboxIndex}
      closeOnImageClick
      enableWheelZoom
    />

    <Dialog open={compareNodes.length === 2} onOpenChange={(open) => (!open ? setCompareNodeIds([]) : null)}>
      <DialogContent className="max-w-5xl rounded-2xl p-0">
        <DialogHeader className="border-b border-stone-200 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Columns2 className="size-4" />
            版本对比
          </DialogTitle>
          <DialogDescription>对比两张结果图的画面、提示词、比例和生成时间。</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[72vh] gap-0 overflow-y-auto md:grid-cols-2">
          {compareNodes.map((node, index) => (
            <div key={node.id} className={cn("space-y-3 p-5", index === 0 ? "border-b border-stone-200 md:border-b-0 md:border-r" : "")}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-stone-900">{node.title}</div>
                  <div className="mt-1 text-xs text-stone-500">{node.size || "未指定比例"} · {formatTime(node.createdAt)}</div>
                </div>
                <Button variant="outline" className="h-8 rounded-full border-stone-200 px-2.5 text-xs" onClick={() => openImageLightbox(node.id)}>
                  <Maximize2 className="size-3.5" />
                </Button>
              </div>
              <div className="flex aspect-square items-center justify-center overflow-hidden rounded-2xl border border-stone-200 bg-stone-50">
                <img src={getImageNodeSrc(node)} alt={node.title} className="h-full w-full object-contain" draggable={false} />
              </div>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600">
                {node.prompt || node.revised_prompt || "无提示词记录"}
              </p>
            </div>
          ))}
        </div>
        <DialogFooter className="border-t border-stone-200 px-5 py-4">
          <Button variant="outline" onClick={() => setCompareNodeIds([])}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(deleteProjectTarget)} onOpenChange={(open) => (!open ? setDeleteProjectTarget(null) : null)}>
      <DialogContent showCloseButton={false} className="rounded-2xl p-6">
        <DialogHeader className="gap-2">
          <DialogTitle>删除画布</DialogTitle>
          <DialogDescription className="text-sm leading-6">
            确认删除「{deleteProjectTarget?.title || "这个画布"}」吗？画布里的节点、连线和保存结果会一起删除，删除后无法恢复。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteProjectTarget(null)}>
            取消
          </Button>
          <Button className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void confirmDeleteProject()}>
            确认删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

export default function CanvasPage() {
  const { isCheckingAuth, session } = useAuthGuard();

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <CanvasPageContent isAdmin={session.role === "admin"} ownerKey={`${session.role}:${session.subjectId || session.name || "default"}`} />;
}
