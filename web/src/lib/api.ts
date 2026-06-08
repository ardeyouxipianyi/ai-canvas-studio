import { httpRequest, request } from "@/lib/request";

export type ImageModel =
  | "gpt-image-2"
  | "codex-gpt-image-2"
  | "plus-codex-gpt-image-2"
  | "team-codex-gpt-image-2"
  | "pro-codex-gpt-image-2"
  | string;
export type AuthRole = "admin" | "user";

export type SettingsConfig = {
  proxy: string;
  base_url?: string;
  global_system_prompt?: string;
  reverse_prompt_instruction?: string;
  sensitive_words?: string[];
  ai_review?: {
    enabled?: boolean;
    base_url?: string;
    api_key?: string;
    model?: string;
    prompt?: string;
  };
  refresh_account_interval_minute?: number | string;
  account_refresh_concurrency?: number | string;
  image_retention_days?: number | string;
  image_poll_timeout_secs?: number | string;
  image_unaccepted_task_timeout_secs?: number | string;
  image_stalled_result_timeout_secs?: number | string;
  image_account_concurrency?: number | string;
  image_account_recheck_interval_secs?: number | string;
  image_pool_failover_enabled?: boolean;
  image_pool_max_attempts?: number | string;
  image_account_failure_cooldown_secs?: number | string;
  image_empty_result_retry_enabled?: boolean;
  auto_remove_invalid_accounts?: boolean;
  auto_remove_rate_limited_accounts?: boolean;
  admin_auth_key_editable?: boolean;
  setup_required?: boolean;
  log_levels?: string[];
  backup?: BackupSettings;
  backup_state?: BackupState;
  [key: string]: unknown;
};

export type BackupInclude = {
  config: boolean;
  register: boolean;
  cpa: boolean;
  sub2api: boolean;
  logs: boolean;
  image_tasks: boolean;
  image_providers: boolean;
  image_conversations: boolean;
  image_canvas: boolean;
  accounts_snapshot: boolean;
  auth_keys_snapshot: boolean;
  images: boolean;
};

export type BackupSettings = {
  enabled: boolean;
  provider: "cloudflare_r2" | string;
  account_id: string;
  access_key_id: string;
  secret_access_key: string;
  bucket: string;
  prefix: string;
  interval_minutes: number | string;
  rotation_keep: number | string;
  encrypt: boolean;
  passphrase: string;
  include: BackupInclude;
};

export type BackupState = {
  running: boolean;
  last_started_at?: string | null;
  last_finished_at?: string | null;
  last_status?: string;
  last_error?: string | null;
  last_object_key?: string | null;
};

export type BackupItem = {
  key: string;
  name: string;
  size: number;
  updated_at?: string | null;
  encrypted: boolean;
};

export type BackupDetail = {
  key: string;
  name: string;
  encrypted: boolean;
  created_at?: string | null;
  trigger?: string | null;
  app_version?: string | null;
  storage_backend?: Record<string, unknown> | null;
  sensitive_included?: boolean | null;
  redacted?: boolean | null;
  files: Array<{
    name: string;
    exists: boolean;
    content_type?: string;
    size: number;
    sha256?: string;
  }>;
  snapshots: Array<{
    name: string;
    count: number;
  }>;
};

export type ManagedImage = {
  rel: string;
  path?: string;
  name: string;
  date: string;
  size: number;
  url: string;
  thumbnail_url?: string;
  created_at: string;
  width?: number;
  height?: number;
  tags?: string[];
  canvas_project_id?: string;
  canvas_project_title?: string;
  canvas_node_id?: string;
  canvas_node_title?: string;
};

export type SystemLog = {
  id: string;
  time: string;
  type: "call" | "account" | string;
  summary?: string;
  detail?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ImageTask = {
  id: string;
  status: "queued" | "running" | "success" | "error" | "cancelled";
  stage?: "queued" | "running" | "archiving" | "success" | "error" | "cancelled" | string;
  mode: "generate" | "edit" | "reverse_prompt";
  provider_id?: string;
  provider_name?: string;
  provider_type?: string;
  model?: ImageModel;
  size?: string;
  quality?: string;
  attempt?: number;
  duration_ms?: number;
  usage?: Record<string, unknown>;
  image_width?: number;
  image_height?: number;
  progress?: number;
  progress_message?: string;
  created_at: string;
  updated_at: string;
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: string;
  message?: string;
};

export type ImageProviderCapabilities = {
  generate: boolean;
  edit: boolean;
  reverse_prompt: boolean;
};

export type ImageProvider = {
  id: string;
  name: string;
  type: "openai_compatible" | string;
  enabled: boolean;
  base_url: string;
  has_api_key: boolean;
  default_model: string;
  default_reverse_prompt_model?: string;
  default_size: string;
  default_quality: string;
  timeout_secs: number;
  capabilities: ImageProviderCapabilities;
  warnings?: string[];
  last_success_at?: string | null;
  last_error_at?: string | null;
  last_error?: string;
  latency_ms?: number;
  success_count?: number;
  error_count?: number;
  model_cache?: string[];
  model_cache_updated_at?: string | null;
};

export type ImageProviderListResponse = {
  items: ImageProvider[];
  default_provider_id: string;
  default_reverse_provider_id?: string;
};

export type ImageProviderInput = Partial<ImageProvider> & {
  api_key?: string;
  keep_api_key?: boolean;
  make_default?: boolean;
  make_reverse_default?: boolean;
};

export type ImagePromptSource = string | { url?: string; data?: string; base64?: string; mime?: string; filename?: string };

export const DEFAULT_REVERSE_PROMPT_INSTRUCTION =
  "请根据这张图片反推出可用于 AI 画图的中文提示词。只输出一段可直接用于生图的提示词，尽量包含主体、构图、风格、光线、色彩、细节、镜头与氛围；不要解释过程，不要加入无关说明。";

type ImageTaskListResponse = {
  items: ImageTask[];
  missing_ids: string[];
};

type ImageTaskCancelResponse = ImageTaskListResponse & {
  cancelled_ids: string[];
};

export type LoginResponse = {
  ok: boolean;
  version: string;
  role: AuthRole;
  subject_id: string;
  name: string;
};

export type SetupStatusResponse = {
  setup_required: boolean;
  admin_auth_key_editable: boolean;
  version: string;
};

export type UserKey = {
  id: string;
  name: string;
  role: "user";
  enabled: boolean;
  created_at: string | null;
  last_used_at: string | null;
  usage?: {
    total_calls?: number;
    successful_calls?: number;
    failed_calls?: number;
    image_calls?: number;
    image_successful_calls?: number;
    image_failed_calls?: number;
    generated_images?: number;
    total_duration_ms?: number;
    last_call_at?: string | null;
    last_success_at?: string | null;
    last_failure_at?: string | null;
  };
};

export async function login(authKey: string) {
  const normalizedAuthKey = String(authKey || "").trim();
  return httpRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: {},
    headers: {
      Authorization: `Bearer ${normalizedAuthKey}`,
    },
    redirectOnUnauthorized: false,
  });
}

export async function fetchSetupStatus() {
  return httpRequest<SetupStatusResponse>("/auth/setup-status", {
    redirectOnUnauthorized: false,
  });
}

export async function initializeAdminPassword(newKey: string) {
  return httpRequest<LoginResponse>("/auth/setup", {
    method: "POST",
    body: {
      new_key: newKey,
    },
    redirectOnUnauthorized: false,
  });
}

export async function updateAdminPassword(currentKey: string, newKey: string) {
  return httpRequest<LoginResponse>("/api/auth/admin-password", {
    method: "POST",
    body: {
      current_key: currentKey,
      new_key: newKey,
    },
  });
}

export async function createImageGenerationTask(clientTaskId: string, prompt: string, model?: ImageModel, size?: string, quality?: string, providerId?: string) {
  return httpRequest<ImageTask>("/api/image-tasks/generations", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      prompt,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    },
  });
}

export async function createImageEditTask(
  clientTaskId: string,
  files: File | File[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: string,
  providerId?: string,
) {
  const formData = new FormData();
  const uploadFiles = Array.isArray(files) ? files : [files];

  uploadFiles.forEach((file) => {
    formData.append("image", file);
  });
  formData.append("client_task_id", clientTaskId);
  formData.append("prompt", prompt);
  if (providerId) {
    formData.append("provider_id", providerId);
  }
  if (model) {
    formData.append("model", model);
  }
  if (size) {
    formData.append("size", size);
  }
  if (quality) {
    formData.append("quality", quality);
  }

  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: formData,
  });
}

export async function createImageEditTaskFromSource(
  clientTaskId: string,
  image: ImagePromptSource,
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: string,
  providerId?: string,
) {
  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      image,
      prompt,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    },
  });
}

export async function createImageEditTaskFromSources(
  clientTaskId: string,
  images: ImagePromptSource[],
  prompt: string,
  model?: ImageModel,
  size?: string,
  quality?: string,
  providerId?: string,
) {
  return httpRequest<ImageTask>("/api/image-tasks/edits", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      images,
      prompt,
      ...(providerId ? { provider_id: providerId } : {}),
      ...(model ? { model } : {}),
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    },
  });
}

export async function createReversePromptTask(
  clientTaskId: string,
  image: ImagePromptSource,
  instruction?: string,
  model?: ImageModel,
  providerId?: string,
) {
  return httpRequest<ImageTask>("/api/image-tasks/reverse-prompts", {
    method: "POST",
    body: {
      client_task_id: clientTaskId,
      image,
      prompt: instruction?.trim() || DEFAULT_REVERSE_PROMPT_INSTRUCTION,
      ...(model ? { model } : {}),
      ...(providerId ? { provider_id: providerId } : {}),
    },
  });
}

export async function fetchReversePromptInstruction() {
  return httpRequest<{ instruction: string }>("/api/reverse-prompt-instruction");
}

export async function updateReversePromptInstruction(instruction: string) {
  return httpRequest<{ instruction: string; config: SettingsConfig }>("/api/reverse-prompt-instruction", {
    method: "POST",
    body: { instruction },
  });
}

export async function fetchImageTasks(ids: string[]) {
  const params = new URLSearchParams();
  if (ids.length > 0) {
    params.set("ids", ids.join(","));
  }
  return httpRequest<ImageTaskListResponse>(`/api/image-tasks${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function createImageTaskEventSource(ids: string[]) {
  if (typeof window === "undefined" || typeof EventSource === "undefined" || ids.length === 0) {
    return null;
  }
  const { getStoredAuthSession } = await import("@/store/auth");
  const session = await getStoredAuthSession();
  const token = session?.key || "";
  if (!token) return null;
  const params = new URLSearchParams();
  params.set("ids", ids.join(","));
  params.set("token", token);
  return new EventSource(`/api/image-tasks/events?${params.toString()}`);
}

export async function cancelImageTasks(ids: string[]) {
  return httpRequest<ImageTaskCancelResponse>("/api/image-tasks/cancel", {
    method: "POST",
    body: { ids },
  });
}

export async function fetchImageProviders() {
  return httpRequest<ImageProviderListResponse>("/api/image-providers");
}

export async function saveImageProvider(provider: ImageProviderInput) {
  return httpRequest<ImageProviderListResponse & { item: ImageProvider }>("/api/image-providers", {
    method: "POST",
    body: provider,
  });
}

export async function deleteImageProvider(providerId: string) {
  return httpRequest<ImageProviderListResponse>(`/api/image-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export async function setDefaultImageProvider(providerId: string, purpose: "generate" | "reverse_prompt" = "generate") {
  return httpRequest<ImageProviderListResponse>("/api/image-providers/default", {
    method: "POST",
    body: { provider_id: providerId, purpose },
  });
}

export async function testImageProvider(providerId: string, model = "") {
  return httpRequest<{ result: ProxyTestResult }>(`/api/image-providers/${encodeURIComponent(providerId)}/test`, {
    method: "POST",
    body: { model },
  });
}

export async function revealImageProviderApiKey(providerId: string) {
  return httpRequest<{ api_key: string }>(`/api/image-providers/${encodeURIComponent(providerId)}/api-key`);
}

export async function fetchImageProviderModels(providerId: string) {
  return httpRequest<{ items: string[] }>(`/api/image-providers/${encodeURIComponent(providerId)}/models`);
}

export async function fetchSettingsConfig() {
  return httpRequest<{ config: SettingsConfig }>("/api/settings");
}

export async function updateSettingsConfig(settings: SettingsConfig) {
  return httpRequest<{ config: SettingsConfig }>("/api/settings", {
    method: "POST",
    body: settings,
  });
}

export async function testBackupConnection() {
  return httpRequest<{ result: { ok: boolean; status: number } }>("/api/backup/test", {
    method: "POST",
    body: {},
  });
}

export async function fetchBackups() {
  return httpRequest<{ items: BackupItem[]; state: BackupState; settings: BackupSettings }>("/api/backups");
}

export async function runBackupNow() {
  return httpRequest<{ result: { key: string; size: number; encrypted: boolean } }>("/api/backups/run", {
    method: "POST",
    body: {},
  });
}

export async function deleteBackup(key: string) {
  return httpRequest<{ ok: boolean }>("/api/backups/delete", {
    method: "POST",
    body: { key },
  });
}

export async function importDataPackage(file: File, include: Partial<BackupInclude>) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("include", JSON.stringify(include));
  return httpRequest<{ ok: boolean; result: { imported?: string[]; skipped?: string[]; counts?: Record<string, number> } }>("/api/data/import", {
    method: "POST",
    body: formData,
  });
}

export async function fetchBackupDetail(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return httpRequest<{ item: BackupDetail }>(`/api/backups/detail?${params.toString()}`);
}

export function getBackupDownloadUrl(key: string) {
  const params = new URLSearchParams();
  params.set("key", key);
  return `/api/backups/download?${params.toString()}`;
}

export async function fetchManagedImages(filters: { start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: ManagedImage[]; groups: Array<{ date: string; items: ManagedImage[] }> }>(
    `/api/images${params.toString() ? `?${params.toString()}` : ""}`,
  );
}

export async function deleteManagedImages(body: { paths?: string[]; start_date?: string; end_date?: string; all_matching?: boolean }) {
  return httpRequest<{ removed: number }>("/api/images/delete", { method: "POST", body });
}

export async function downloadImages(paths: string[]) {
  const response = await request.post("/api/images/download", { paths }, { responseType: "blob" });
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "images.zip";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadSingleImage(path: string) {
  const response = await request.get(`/api/images/download/${path}`, { responseType: "blob" });
  const blob = response.data as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "image.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function fetchImageTags() {
  return httpRequest<{ tags: string[] }>("/api/images/tags");
}

export async function setImageTags(path: string, tags: string[]) {
  return httpRequest<{ ok: boolean; tags: string[] }>("/api/images/tags", {
    method: "POST",
    body: { path, tags },
  });
}

export async function deleteImageTag(tag: string) {
  return httpRequest<{ ok: boolean; removed_from: number }>(`/api/images/tags/${encodeURIComponent(tag)}`, {
    method: "DELETE",
  });
}

export async function fetchSystemLogs(filters: { type?: string; start_date?: string; end_date?: string }) {
  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.start_date) params.set("start_date", filters.start_date);
  if (filters.end_date) params.set("end_date", filters.end_date);
  return httpRequest<{ items: SystemLog[] }>(`/api/logs${params.toString() ? `?${params.toString()}` : ""}`);
}

export async function deleteSystemLogs(ids: string[]) {
  return httpRequest<{ removed: number }>("/api/logs/delete", {
    method: "POST",
    body: { ids },
  });
}

export async function fetchUserKeys() {
  return httpRequest<{ items: UserKey[] }>("/api/auth/users");
}

export async function createUserKey(name: string) {
  return httpRequest<{ item: UserKey; key: string; items: UserKey[] }>("/api/auth/users", {
    method: "POST",
    body: { name },
  });
}

export async function updateUserKey(keyId: string, updates: { enabled?: boolean; name?: string; key?: string }) {
  return httpRequest<{ item: UserKey; items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "POST",
    body: updates,
  });
}

export async function deleteUserKey(keyId: string) {
  return httpRequest<{ items: UserKey[] }>(`/api/auth/users/${keyId}`, {
    method: "DELETE",
  });
}


// ── CPA (CLIProxyAPI) ──────────────────────────────────────────────

// ── Sub2API ────────────────────────────────────────────────────────

// ── Upstream proxy ────────────────────────────────────────────────

export type ProxySettings = {
  enabled: boolean;
  url: string;
};

export type ProxyTestResult = {
  ok: boolean;
  status: number;
  latency_ms: number;
  error: string | null;
  warnings?: string[];
};

export async function fetchProxy() {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy");
}

export async function updateProxy(updates: { enabled?: boolean; url?: string }) {
  return httpRequest<{ proxy: ProxySettings }>("/api/proxy", {
    method: "POST",
    body: updates,
  });
}

export async function testProxy(url?: string) {
  return httpRequest<{ result: ProxyTestResult }>("/api/proxy/test", {
    method: "POST",
    body: { url: url ?? "" },
  });
}
