"use client";

import type { ImageCanvasNode, ImageCanvasProject } from "@/store/image-canvas";

export const CANVAS_HISTORY_LIMIT = 40;

export type CanvasRect = { x: number; y: number; width: number; height: number };
export type CanvasSelectionBox = CanvasRect;

export function cloneCanvasProject(project: ImageCanvasProject): ImageCanvasProject {
  return JSON.parse(JSON.stringify(project)) as ImageCanvasProject;
}

export function getAdaptiveImageNodeDimensions(node: Pick<ImageCanvasNode, "type" | "width" | "height" | "imageWidth" | "imageHeight">) {
  if (node.type !== "image") {
    return { width: node.width, height: node.height, mediaHeight: 0 };
  }

  const imageWidth = Number(node.imageWidth || 0);
  const imageHeight = Number(node.imageHeight || 0);
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    return { width: node.width, height: node.height, mediaHeight: 188 };
  }

  const ratio = imageWidth / imageHeight;
  const normalizedWidth = Math.round(Math.sqrt(Math.max(ratio, 0.01)) * 300);
  const width = Math.min(360, Math.max(240, normalizedWidth));
  const mediaWidth = Math.max(160, width - 24);
  const mediaHeight = Math.max(120, Math.round(mediaWidth / ratio));
  const height = 44 + 12 + mediaHeight + 12 + 20 + 12;

  return { width, height, mediaHeight };
}

export function getNodeRenderHeight(node: Pick<ImageCanvasNode, "type" | "height" | "width" | "imageWidth" | "imageHeight">) {
  if (node.type !== "image") return node.height;
  return getAdaptiveImageNodeDimensions(node).height;
}

export function selectionBoxFromPoints(startX: number, startY: number, currentX: number, currentY: number): CanvasSelectionBox {
  const x = Math.min(startX, currentX);
  const y = Math.min(startY, currentY);
  return {
    x,
    y,
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY),
  };
}

export function rectsOverlap(rectA: CanvasRect, rectB: CanvasRect, gap = 36) {
  return !(
    rectA.x + rectA.width + gap <= rectB.x ||
    rectB.x + rectB.width + gap <= rectA.x ||
    rectA.y + rectA.height + gap <= rectB.y ||
    rectB.y + rectB.height + gap <= rectA.y
  );
}

export function nodeToRect(node: ImageCanvasNode): CanvasRect {
  return {
    x: node.x,
    y: node.y,
    width: node.width,
    height: getNodeRenderHeight(node),
  };
}

export function getNodesInSelection(nodes: ImageCanvasNode[], box: CanvasSelectionBox) {
  if (box.width < 8 && box.height < 8) return [];
  return nodes.filter((node) => rectsOverlap(box, nodeToRect(node), 0));
}

export function alignCanvasNodes(nodes: ImageCanvasNode[], nodeIds: string[], axis: "x" | "y") {
  const idSet = new Set(nodeIds);
  const selected = nodes.filter((node) => idSet.has(node.id));
  if (selected.length < 2) return nodes;
  const targetCenter =
    selected.reduce((total, node) => total + (axis === "x" ? node.x + node.width / 2 : node.y + getNodeRenderHeight(node) / 2), 0) /
    selected.length;
  const now = new Date().toISOString();
  return nodes.map((node) => {
    if (!idSet.has(node.id)) return node;
    return {
      ...node,
      x: axis === "x" ? targetCenter - node.width / 2 : node.x,
      y: axis === "y" ? targetCenter - getNodeRenderHeight(node) / 2 : node.y,
      updatedAt: now,
    };
  });
}
