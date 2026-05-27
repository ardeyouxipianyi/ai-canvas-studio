"use client";

import localforage from "localforage";

import { httpRequest } from "@/lib/request";
import { getStoredAuthSession } from "@/store/auth";
import type { ImageModel } from "@/lib/api";

export type ImageConversationMode = "generate" | "edit";

export type StoredReferenceImage = {
  name: string;
  type: string;
  dataUrl: string;
};

export type StoredImage = {
  id: string;
  taskId?: string;
  status?: "loading" | "success" | "error";
  progress?: number;
  progressMessage?: string;
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
  error?: string;
};

export type ImageTurnStatus = "queued" | "generating" | "success" | "error";

export type ImageTurn = {
  id: string;
  prompt: string;
  model: ImageModel;
  mode: ImageConversationMode;
  referenceImages: StoredReferenceImage[];
  count: number;
  size: string;
  images: StoredImage[];
  createdAt: string;
  status: ImageTurnStatus;
  error?: string;
  promptDeleted?: boolean;
  resultsDeleted?: boolean;
};

export type ImageConversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ImageTurn[];
};

export type ImageConversationStats = {
  queued: number;
  running: number;
};

const imageConversationStorage = localforage.createInstance({
  name: "chatgpt2api",
  storeName: "image_conversations",
});

const IMAGE_CONVERSATIONS_KEY = "items";
const IMAGE_CONVERSATIONS_SERVER_MIGRATION_KEY_PREFIX = "server_migrated";
let imageConversationWriteQueue: Promise<void> = Promise.resolve();

type ImageConversationListResponse = {
  items: Array<ImageConversation & Record<string, unknown>>;
};

type ImageConversationSaveResponse = {
  item: ImageConversation & Record<string, unknown>;
};

type ImageConversationBatchSaveResponse = {
  items: Array<ImageConversation & Record<string, unknown>>;
};

function normalizeStoredImage(image: StoredImage): StoredImage {
  const normalized = {
    ...image,
    taskId: typeof image.taskId === "string" && image.taskId ? image.taskId : undefined,
    progress: typeof image.progress === "number" && Number.isFinite(image.progress) ? Math.max(0, Math.min(100, Math.round(image.progress))) : undefined,
    progressMessage: typeof image.progressMessage === "string" ? image.progressMessage : undefined,
    url: typeof image.url === "string" && image.url ? image.url : undefined,
    revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
  };
  if (image.status === "loading" || image.status === "error" || image.status === "success") {
    return normalized;
  }
  return {
    ...normalized,
    status: image.b64_json || image.url ? "success" : "loading",
  };
}

function normalizeReferenceImage(image: StoredReferenceImage): StoredReferenceImage {
  return {
    name: image.name || "reference.png",
    type: image.type || "image/png",
    dataUrl: image.dataUrl,
  };
}

function dataUrlMimeType(dataUrl: string) {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return match?.[1] || "image/png";
}

function getLegacyReferenceImages(source: Record<string, unknown>): StoredReferenceImage[] {
  if (Array.isArray(source.referenceImages)) {
    return source.referenceImages
      .filter((image): image is StoredReferenceImage => {
        if (!image || typeof image !== "object") {
          return false;
        }
        const candidate = image as StoredReferenceImage;
        return typeof candidate.dataUrl === "string" && candidate.dataUrl.length > 0;
      })
      .map(normalizeReferenceImage);
  }

  if (source.sourceImage && typeof source.sourceImage === "object") {
    const image = source.sourceImage as { dataUrl?: unknown; fileName?: unknown };
    if (typeof image.dataUrl === "string" && image.dataUrl) {
      return [
        {
          name: typeof image.fileName === "string" && image.fileName ? image.fileName : "reference.png",
          type: dataUrlMimeType(image.dataUrl),
          dataUrl: image.dataUrl,
        },
      ];
    }
  }

  return [];
}

function normalizeTurn(turn: ImageTurn & Record<string, unknown>): ImageTurn {
  const normalizedImages = Array.isArray(turn.images) ? turn.images.map(normalizeStoredImage) : [];
  const derivedStatus: ImageTurnStatus =
    normalizedImages.some((image) => image.status === "loading")
      ? "generating"
      : normalizedImages.some((image) => image.status === "error")
        ? "error"
        : "success";

  return {
    id: String(turn.id || `${Date.now()}`),
    prompt: String(turn.prompt || ""),
    model: (turn.model as ImageModel) || "gpt-image-2",
    mode: turn.mode === "edit" ? "edit" : "generate",
    referenceImages: getLegacyReferenceImages(turn),
    count: Math.max(1, Number(turn.count || normalizedImages.length || 1)),
    size: typeof turn.size === "string" ? turn.size : "",
    images: normalizedImages,
    createdAt: String(turn.createdAt || new Date().toISOString()),
    status:
      turn.status === "queued" ||
      turn.status === "generating" ||
      turn.status === "success" ||
      turn.status === "error"
        ? turn.status
        : derivedStatus,
    error: typeof turn.error === "string" ? turn.error : undefined,
    promptDeleted: turn.promptDeleted === true,
    resultsDeleted: turn.resultsDeleted === true,
  };
}

function normalizeConversation(conversation: ImageConversation & Record<string, unknown>): ImageConversation {
  const turns = Array.isArray(conversation.turns)
    ? conversation.turns.map((turn) => normalizeTurn(turn as ImageTurn & Record<string, unknown>))
    : [
        normalizeTurn({
          id: String(conversation.id || `${Date.now()}`),
          prompt: String(conversation.prompt || ""),
          model: (conversation.model as ImageModel) || "gpt-image-2",
          mode: conversation.mode === "edit" ? "edit" : "generate",
          referenceImages: getLegacyReferenceImages(conversation),
          count: Number(conversation.count || 1),
          size: typeof conversation.size === "string" ? conversation.size : "",
          images: Array.isArray(conversation.images) ? (conversation.images as StoredImage[]) : [],
          createdAt: String(conversation.createdAt || new Date().toISOString()),
          status:
            conversation.status === "generating" || conversation.status === "success" || conversation.status === "error"
              ? conversation.status
              : "success",
          error: typeof conversation.error === "string" ? conversation.error : undefined,
        }),
      ];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;

  return {
    id: String(conversation.id || `${Date.now()}`),
    title: String(conversation.title || ""),
    createdAt: String(conversation.createdAt || lastTurn?.createdAt || new Date().toISOString()),
    updatedAt: String(conversation.updatedAt || lastTurn?.createdAt || new Date().toISOString()),
    turns,
  };
}

function shouldKeepTurn(turn: ImageTurn): boolean {
  if (turn.prompt.trim() || turn.promptDeleted) {
    return true;
  }
  if (turn.referenceImages.length > 0) {
    return true;
  }
  return turn.images.some((image) => image.status === "loading" || image.status === "error" || Boolean(image.taskId));
}

function pruneOrphanResultTurns(conversation: ImageConversation): ImageConversation | null {
  const turns = conversation.turns.filter(shouldKeepTurn);
  if (turns.length === 0) {
    return null;
  }
  if (turns.length === conversation.turns.length) {
    return conversation;
  }
  return {
    ...conversation,
    turns,
    updatedAt: turns.at(-1)?.createdAt || conversation.updatedAt,
  };
}

function sortImageConversations(conversations: ImageConversation[]): ImageConversation[] {
  return [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getTimestamp(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pickLatestConversation(current: ImageConversation, next: ImageConversation) {
  return getTimestamp(next.updatedAt) >= getTimestamp(current.updatedAt) ? next : current;
}

function queueImageConversationWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = imageConversationWriteQueue.then(operation);
  imageConversationWriteQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function readStoredImageConversations(): Promise<ImageConversation[]> {
  const items =
    (await imageConversationStorage.getItem<Array<ImageConversation & Record<string, unknown>>>(
      IMAGE_CONVERSATIONS_KEY,
    )) || [];
  const normalizedItems = items.map(normalizeConversation);
  const prunedItems = normalizedItems.flatMap((conversation) => {
    const pruned = pruneOrphanResultTurns(conversation);
    return pruned ? [pruned] : [];
  });
  if (
    prunedItems.length !== normalizedItems.length ||
    prunedItems.some((conversation, index) => conversation.turns.length !== normalizedItems[index]?.turns.length)
  ) {
    await imageConversationStorage.setItem(IMAGE_CONVERSATIONS_KEY, sortImageConversations(prunedItems));
  }
  return prunedItems;
}

async function writeStoredImageConversations(conversations: ImageConversation[]) {
  await imageConversationStorage.setItem(IMAGE_CONVERSATIONS_KEY, sortImageConversations(conversations.map(normalizeConversation)));
}

async function listRemoteImageConversations(): Promise<ImageConversation[]> {
  const data = await httpRequest<ImageConversationListResponse>("/api/image-conversations");
  return sortImageConversations((data.items || []).map(normalizeConversation));
}

async function saveRemoteImageConversation(conversation: ImageConversation): Promise<ImageConversation> {
  const data = await httpRequest<ImageConversationSaveResponse>("/api/image-conversations", {
    method: "POST",
    body: normalizeConversation(conversation),
  });
  return normalizeConversation(data.item);
}

async function saveRemoteImageConversations(conversations: ImageConversation[]): Promise<ImageConversation[]> {
  const data = await httpRequest<ImageConversationBatchSaveResponse>("/api/image-conversations/batch", {
    method: "POST",
    body: { items: conversations.map(normalizeConversation) },
  });
  return sortImageConversations((data.items || []).map(normalizeConversation));
}

async function getMigrationKey() {
  const session = await getStoredAuthSession();
  if (!session) {
    return "";
  }
  return `${IMAGE_CONVERSATIONS_SERVER_MIGRATION_KEY_PREFIX}:${session.role}:${session.subjectId || session.name || "unknown"}`;
}

async function shouldMigrateLocalConversations() {
  const migrationKey = await getMigrationKey();
  if (!migrationKey) {
    return false;
  }
  return !(await imageConversationStorage.getItem<boolean>(migrationKey));
}

async function markLocalConversationsMigrated() {
  const migrationKey = await getMigrationKey();
  if (migrationKey) {
    await imageConversationStorage.setItem(migrationKey, true);
  }
}

export async function listImageConversations(): Promise<ImageConversation[]> {
  const remoteItems = await listRemoteImageConversations();
  if (!(await shouldMigrateLocalConversations())) {
    await writeStoredImageConversations(remoteItems);
    return remoteItems;
  }

  const localItems = sortImageConversations(await readStoredImageConversations());
  if (localItems.length === 0) {
    await markLocalConversationsMigrated();
    await writeStoredImageConversations(remoteItems);
    return remoteItems;
  }

  const conversationMap = new Map(remoteItems.map((item) => [item.id, item]));
  for (const conversation of localItems) {
    const current = conversationMap.get(conversation.id);
    conversationMap.set(conversation.id, current ? pickLatestConversation(current, conversation) : conversation);
  }
  const migratedItems = await saveRemoteImageConversations(sortImageConversations([...conversationMap.values()]));
  await markLocalConversationsMigrated();
  await writeStoredImageConversations(migratedItems);
  return migratedItems;
}

export async function saveImageConversations(conversations: ImageConversation[]): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await listRemoteImageConversations();
    const conversationMap = new Map(items.map((item) => [item.id, item]));
    for (const conversation of conversations.map(normalizeConversation)) {
      const current = conversationMap.get(conversation.id);
      conversationMap.set(conversation.id, current ? pickLatestConversation(current, conversation) : conversation);
    }
    const savedItems = await saveRemoteImageConversations(sortImageConversations([...conversationMap.values()]));
    await writeStoredImageConversations(savedItems);
  });
}

export async function saveImageConversation(conversation: ImageConversation): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await listRemoteImageConversations();
    const nextConversation = normalizeConversation(conversation);
    const current = items.find((item) => item.id === nextConversation.id);
    const persistedConversation = current ? pickLatestConversation(current, nextConversation) : nextConversation;
    const savedConversation = await saveRemoteImageConversation(persistedConversation);
    await writeStoredImageConversations([
      savedConversation,
      ...items.filter((item) => item.id !== savedConversation.id),
    ]);
  });
}

export async function renameImageConversation(id: string, title: string): Promise<void> {
  await queueImageConversationWrite(async () => {
    const items = await listRemoteImageConversations();
    const target = items.find((item) => item.id === id);
    if (!target) return;
    const updated = { ...target, title, updatedAt: new Date().toISOString() };
    const savedConversation = await saveRemoteImageConversation(updated);
    await writeStoredImageConversations([
      savedConversation,
      ...items.filter((item) => item.id !== id),
    ]);
  });
}

export async function deleteImageConversation(id: string): Promise<void> {
  await queueImageConversationWrite(async () => {
    await httpRequest(`/api/image-conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const items = await readStoredImageConversations();
    await writeStoredImageConversations(items.filter((item) => item.id !== id));
  });
}

export async function clearImageConversations(): Promise<void> {
  await queueImageConversationWrite(async () => {
    await httpRequest("/api/image-conversations", {
      method: "DELETE",
    });
    await imageConversationStorage.removeItem(IMAGE_CONVERSATIONS_KEY);
  });
}

export function getImageConversationStats(conversation: ImageConversation | null): ImageConversationStats {
  if (!conversation) {
    return { queued: 0, running: 0 };
  }

  return conversation.turns.reduce(
    (acc, turn) => {
      if (turn.resultsDeleted) {
        return acc;
      }
      if (turn.status === "queued") {
        acc.queued += 1;
      } else if (turn.status === "generating") {
        acc.running += 1;
      }
      return acc;
    },
    { queued: 0, running: 0 },
  );
}
