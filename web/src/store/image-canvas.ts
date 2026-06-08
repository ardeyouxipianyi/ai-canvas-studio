"use client";

import localforage from "localforage";

import { httpRequest } from "@/lib/request";
import { getStoredAuthSession } from "@/store/auth";
import type { ImageModel } from "@/lib/api";

export type ImageCanvasNodeType = "prompt" | "edit" | "image";
export type ImageCanvasNodeStatus = "idle" | "queued" | "generating" | "success" | "error" | "cancelled";

export type ImageCanvasNode = {
  id: string;
  type: ImageCanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  prompt?: string;
  batchId?: string;
  providerId?: string;
  providerName?: string;
  providerType?: string;
  model?: ImageModel;
  size?: string;
  count?: number;
  sourceNodeId?: string;
  taskId?: string;
  status: ImageCanvasNodeStatus;
  progress?: number;
  progressMessage?: string;
  b64_json?: string;
  url?: string;
  imageWidth?: number;
  imageHeight?: number;
  durationMs?: number;
  usage?: Record<string, unknown>;
  revised_prompt?: string;
  error?: string;
  favorite?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ImageCanvasEdge = {
  id: string;
  from: string;
  to: string;
};

export type ImageCanvasViewport = {
  x: number;
  y: number;
  zoom: number;
};

export type ImageCanvasProject = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  viewport: ImageCanvasViewport;
  nodes: ImageCanvasNode[];
  edges: ImageCanvasEdge[];
};

const imageCanvasStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "image_canvas_projects",
});

const IMAGE_CANVAS_PROJECTS_KEY = "items";
const IMAGE_CANVAS_SERVER_MIGRATION_KEY_PREFIX = "server_migrated";
let imageCanvasWriteQueue: Promise<void> = Promise.resolve();

type ImageCanvasProjectListResponse = {
  items: Array<ImageCanvasProject & Record<string, unknown>>;
};

type ImageCanvasProjectSaveResponse = {
  item: ImageCanvasProject & Record<string, unknown>;
};

export function createImageCanvasId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createBlankImageCanvasProject(title = "未命名画布"): ImageCanvasProject {
  const now = new Date().toISOString();
  return {
    id: createImageCanvasId(),
    title,
    createdAt: now,
    updatedAt: now,
    viewport: { x: 80, y: 64, zoom: 1 },
    nodes: [],
    edges: [],
  };
}

function normalizeNumber(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeProgress(value: unknown, fallback: number) {
  return Math.max(0, Math.min(100, Math.round(normalizeNumber(value, fallback))));
}

function normalizePositiveInteger(value: unknown) {
  const numberValue = normalizeNumber(value, 0);
  return numberValue > 0 ? Math.round(numberValue) : undefined;
}

function normalizeNode(node: ImageCanvasNode & Record<string, unknown>): ImageCanvasNode {
  const now = new Date().toISOString();
  const type: ImageCanvasNodeType = node.type === "edit" || node.type === "image" ? node.type : "prompt";
  const status: ImageCanvasNodeStatus =
    node.status === "queued" ||
    node.status === "generating" ||
    node.status === "success" ||
    node.status === "error" ||
    node.status === "cancelled" ||
    node.status === "idle"
      ? node.status
      : node.b64_json || node.url
        ? "success"
        : type === "image"
          ? "queued"
          : "idle";

  return {
    id: String(node.id || createImageCanvasId()),
    type,
    x: normalizeNumber(node.x, 0),
    y: normalizeNumber(node.y, 0),
    width: normalizeNumber(node.width, type === "image" ? 300 : 320),
    height: normalizeNumber(node.height, type === "image" ? 260 : 220),
    title: String(node.title || (type === "edit" ? "编辑节点" : type === "image" ? "图片结果" : "提示词节点")),
    prompt: typeof node.prompt === "string" ? node.prompt : undefined,
    batchId: typeof node.batchId === "string" ? node.batchId : undefined,
    providerId: typeof node.providerId === "string" ? node.providerId : undefined,
    providerName: typeof node.providerName === "string" ? node.providerName : undefined,
    providerType: typeof node.providerType === "string" ? node.providerType : undefined,
    model: (node.model as ImageModel) || "gpt-image-2",
    size: typeof node.size === "string" ? node.size : "",
    count: Math.max(1, Math.floor(Number(node.count || 1))),
    sourceNodeId: typeof node.sourceNodeId === "string" ? node.sourceNodeId : undefined,
    taskId: typeof node.taskId === "string" ? node.taskId : undefined,
    status,
    progress: normalizeProgress(node.progress, status === "success" || status === "error" || status === "cancelled" ? 100 : 0),
    progressMessage: typeof node.progressMessage === "string" ? node.progressMessage : undefined,
    b64_json: typeof node.b64_json === "string" ? node.b64_json : undefined,
    url: typeof node.url === "string" ? node.url : undefined,
    imageWidth: normalizePositiveInteger(node.imageWidth),
    imageHeight: normalizePositiveInteger(node.imageHeight),
    durationMs: normalizePositiveInteger(node.durationMs),
    usage: node.usage && typeof node.usage === "object" && !Array.isArray(node.usage) ? { ...(node.usage as Record<string, unknown>) } : undefined,
    revised_prompt: typeof node.revised_prompt === "string" ? node.revised_prompt : undefined,
    error: typeof node.error === "string" ? node.error : undefined,
    favorite: Boolean(node.favorite),
    createdAt: String(node.createdAt || now),
    updatedAt: String(node.updatedAt || node.createdAt || now),
  };
}

function normalizeEdge(edge: ImageCanvasEdge & Record<string, unknown>): ImageCanvasEdge {
  return {
    id: String(edge.id || createImageCanvasId()),
    from: String(edge.from || ""),
    to: String(edge.to || ""),
  };
}

function normalizeProject(project: ImageCanvasProject & Record<string, unknown>): ImageCanvasProject {
  const now = new Date().toISOString();
  const nodes = Array.isArray(project.nodes)
    ? project.nodes.map((node) => normalizeNode(node as ImageCanvasNode & Record<string, unknown>))
    : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(project.edges)
    ? project.edges
        .map((edge) => normalizeEdge(edge as ImageCanvasEdge & Record<string, unknown>))
        .filter((edge) => edge.from && edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to))
    : [];
  const viewport = project.viewport || {};

  return {
    id: String(project.id || createImageCanvasId()),
    title: String(project.title || "未命名画布"),
    createdAt: String(project.createdAt || now),
    updatedAt: String(project.updatedAt || project.createdAt || now),
    viewport: {
      x: normalizeNumber((viewport as ImageCanvasViewport).x, 80),
      y: normalizeNumber((viewport as ImageCanvasViewport).y, 64),
      zoom: Math.min(1.8, Math.max(0.35, normalizeNumber((viewport as ImageCanvasViewport).zoom, 1))),
    },
    nodes,
    edges,
  };
}

function sortProjects(projects: ImageCanvasProject[]) {
  return [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function queueImageCanvasWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = imageCanvasWriteQueue.then(operation);
  imageCanvasWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStoredProjects(): Promise<ImageCanvasProject[]> {
  const items =
    (await imageCanvasStorage.getItem<Array<ImageCanvasProject & Record<string, unknown>>>(IMAGE_CANVAS_PROJECTS_KEY)) ||
    [];
  return items.map(normalizeProject);
}

async function listRemoteProjects(): Promise<ImageCanvasProject[]> {
  const data = await httpRequest<ImageCanvasProjectListResponse>("/api/image-canvas/projects");
  return sortProjects((data.items || []).map(normalizeProject));
}

async function saveRemoteProject(project: ImageCanvasProject): Promise<ImageCanvasProject> {
  const data = await httpRequest<ImageCanvasProjectSaveResponse>("/api/image-canvas/projects", {
    method: "POST",
    body: normalizeProject(project),
  });
  return normalizeProject(data.item);
}

async function getMigrationKey() {
  const session = await getStoredAuthSession();
  if (!session) {
    return "";
  }
  return `${IMAGE_CANVAS_SERVER_MIGRATION_KEY_PREFIX}:${session.role}:${session.subjectId || session.name || "unknown"}`;
}

async function shouldMigrateLocalProjects() {
  const session = await getStoredAuthSession();
  if (session?.role !== "admin") {
    return false;
  }
  const migrationKey = await getMigrationKey();
  if (!migrationKey) {
    return false;
  }
  return !(await imageCanvasStorage.getItem<boolean>(migrationKey));
}

async function markLocalProjectsMigrated() {
  const migrationKey = await getMigrationKey();
  if (migrationKey) {
    await imageCanvasStorage.setItem(migrationKey, true);
  }
}

export async function listImageCanvasProjects(): Promise<ImageCanvasProject[]> {
  const remoteProjects = await listRemoteProjects();
  if (remoteProjects.length > 0 || !(await shouldMigrateLocalProjects())) {
    return remoteProjects;
  }

  const localProjects = sortProjects(await readStoredProjects());
  if (localProjects.length === 0) {
    await markLocalProjectsMigrated();
    return remoteProjects;
  }

  const migratedProjects: ImageCanvasProject[] = [];
  for (const project of localProjects) {
    migratedProjects.push(await saveRemoteProject(project));
  }
  await markLocalProjectsMigrated();
  return sortProjects(migratedProjects);
}

export async function saveImageCanvasProject(project: ImageCanvasProject): Promise<void> {
  await queueImageCanvasWrite(async () => {
    await saveRemoteProject(project);
  });
}

export async function deleteImageCanvasProject(id: string): Promise<void> {
  await queueImageCanvasWrite(async () => {
    await httpRequest(`/api/image-canvas/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  });
}
