"use client";

import { CheckCircle2, Eye, EyeOff, LoaderCircle, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteImageProvider, fetchImageProviderModels, fetchImageProviders, revealImageProviderApiKey, saveImageProvider, setDefaultImageProvider, testImageProvider, type ImageProvider, type ImageProviderCapabilities } from "@/lib/api";

type ProviderForm = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
  default_size: string;
  default_quality: string;
  timeout_secs: string;
  enabled: boolean;
  capabilities: ImageProviderCapabilities;
};

const emptyForm: ProviderForm = {
  id: "",
  name: "OpenAI Compatible",
  base_url: "",
  api_key: "",
  default_model: "gpt-image-1",
  default_size: "",
  default_quality: "auto",
  timeout_secs: "180",
  enabled: true,
  capabilities: {
    generate: true,
    edit: true,
    reverse_prompt: false,
  },
};

function looksLikeUrl(value: string) {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/[ /。．.，,、；;]+$/g, "");
}

function providerFormWarnings(form: ProviderForm) {
  const warnings: string[] = [];
  const baseUrl = normalizeBaseUrl(form.base_url);
  if (baseUrl && !baseUrl.toLowerCase().endsWith("/v1")) {
    warnings.push("Base URL 通常需要以 /v1 结尾，例如 https://host/v1。");
  }
  if (form.api_key.trim() && looksLikeUrl(form.api_key)) {
    warnings.push("API Key 看起来像 URL，请填写真正的密钥。");
  }
  return warnings;
}

function providerToForm(provider: ImageProvider): ProviderForm {
  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_key: "",
    default_model: provider.default_model || "gpt-image-1",
    default_size: provider.default_size || "",
    default_quality: provider.default_quality || "auto",
    timeout_secs: String(provider.timeout_secs || 180),
    enabled: Boolean(provider.enabled),
    capabilities: {
      generate: Boolean(provider.capabilities?.generate ?? true),
      edit: Boolean(provider.capabilities?.edit ?? true),
      reverse_prompt: Boolean(provider.capabilities?.reverse_prompt ?? false),
    },
  };
}

export function ImageProvidersCard() {
  const [items, setItems] = useState<ImageProvider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState("");
  const [defaultReverseProviderId, setDefaultReverseProviderId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<ProviderForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testingModel, setTestingModel] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const formWarnings = providerFormWarnings(form);
  const enabledProviders = items.filter((provider) => provider.enabled);
  const generationProvider = enabledProviders.find((provider) => provider.id === defaultProviderId);
  const reverseProvider = enabledProviders.find((provider) => provider.id === defaultReverseProviderId);

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchImageProviders();
      setItems(data.items);
      setDefaultProviderId(data.default_provider_id || "");
      setDefaultReverseProviderId(data.default_reverse_provider_id || "");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载模型服务失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openAdd = (purpose: "generate" | "reverse_prompt" = "generate") => {
    setForm({
      ...emptyForm,
      name: purpose === "reverse_prompt" ? "反推模型服务" : "生图模型服务",
      capabilities: purpose === "reverse_prompt"
        ? { generate: false, edit: true, reverse_prompt: true }
        : { generate: true, edit: true, reverse_prompt: false },
    });
    setModelOptions([]);
    setShowApiKey(false);
    setDialogOpen(true);
  };

  const openEdit = (provider: ImageProvider) => {
    setForm(providerToForm(provider));
    setModelOptions(provider.model_cache || []);
    setShowApiKey(false);
    setDialogOpen(true);
  };

  const updateForm = <K extends keyof ProviderForm>(key: K, value: ProviderForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    if (form.api_key.trim() && looksLikeUrl(form.api_key)) {
      toast.error("API Key 不能填写 URL，请填写真正的密钥");
      return;
    }
    setSaving(true);
    try {
      const data = await saveImageProvider({
        id: form.id || undefined,
        name: form.name.trim(),
        type: "openai_compatible",
        enabled: form.enabled,
        base_url: normalizeBaseUrl(form.base_url),
        api_key: form.api_key.trim(),
        keep_api_key: Boolean(form.id && !form.api_key.trim()),
        default_model: form.default_model.trim(),
        default_size: form.default_size.trim(),
        default_quality: form.default_quality.trim() || "auto",
        timeout_secs: Number(form.timeout_secs) || 180,
        capabilities: form.capabilities,
        make_default: !defaultProviderId,
        make_reverse_default: (!defaultReverseProviderId || !reverseProvider) && form.capabilities.reverse_prompt,
      });
      setItems(data.items);
      setDefaultProviderId(data.default_provider_id || "");
      setDefaultReverseProviderId(data.default_reverse_provider_id || "");
      setDialogOpen(false);
      toast.success("模型服务已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存模型服务失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (provider: ImageProvider) => {
    setDeletingId(provider.id);
    try {
      const data = await deleteImageProvider(provider.id);
      setItems(data.items);
      setDefaultProviderId(data.default_provider_id || "");
      setDefaultReverseProviderId(data.default_reverse_provider_id || "");
      toast.success("模型服务已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除模型服务失败");
    } finally {
      setDeletingId(null);
    }
  };

  const handleSetDefault = async (provider: ImageProvider, purpose: "generate" | "reverse_prompt" = "generate") => {
    const previousDefaultProviderId = defaultProviderId;
    const previousDefaultReverseProviderId = defaultReverseProviderId;
    if (purpose === "reverse_prompt") {
      setDefaultReverseProviderId(provider.id);
      setItems((current) =>
        current.map((item) =>
          item.id === provider.id
            ? { ...item, capabilities: { ...item.capabilities, edit: true, reverse_prompt: true } }
            : item,
        ),
      );
    } else {
      setDefaultProviderId(provider.id);
    }
    try {
      await setDefaultImageProvider(provider.id, purpose);
      const refreshed = await fetchImageProviders();
      setItems(refreshed.items);
      setDefaultProviderId(refreshed.default_provider_id || "");
      setDefaultReverseProviderId(refreshed.default_reverse_provider_id || "");
      toast.success(purpose === "reverse_prompt" ? "反推模型服务已更新" : "生图模型服务已更新");
    } catch (error) {
      setDefaultProviderId(previousDefaultProviderId);
      setDefaultReverseProviderId(previousDefaultReverseProviderId);
      toast.error(error instanceof Error ? error.message : "设置默认模型服务失败");
    }
  };

  const handleTest = async (provider: ImageProvider) => {
    setTestingId(provider.id);
    try {
      const data = await testImageProvider(provider.id);
      if (data.result.ok) {
        if (data.result.warnings?.length) {
          toast.warning(`连接可用，但配置有提示：${data.result.warnings[0]}`);
        } else {
          toast.success(`连接正常：HTTP ${data.result.status}，${data.result.latency_ms} ms`);
        }
      } else {
        toast.error(data.result.error || "连接测试失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setTestingId(null);
    }
  };

  const handleFetchModels = async () => {
    if (!form.id) {
      toast.error("请先保存模型服务，再获取模型列表");
      return;
    }
    setLoadingModels(true);
    try {
      const data = await fetchImageProviderModels(form.id);
      const models = Array.from(new Set((data.items || []).map((item) => String(item || "").trim()).filter(Boolean)));
      setModelOptions(models);
      if (models.length === 0) {
        toast.error("没有获取到模型列表");
        return;
      }
      updateForm("default_model", form.default_model.trim() || models[0]);
      const refreshed = await fetchImageProviders();
      setItems(refreshed.items);
      setDefaultProviderId(refreshed.default_provider_id || "");
      setDefaultReverseProviderId(refreshed.default_reverse_provider_id || "");
      toast.success(`已获取 ${models.length} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "获取模型列表失败");
    } finally {
      setLoadingModels(false);
    }
  };

  const handleTestCurrentModel = async () => {
    if (!form.id) {
      toast.error("请先保存模型服务，再测试当前模型");
      return;
    }
    const model = form.default_model.trim();
    if (!model) {
      toast.error("请先填写或选择模型");
      return;
    }
    setTestingModel(true);
    try {
      const data = await testImageProvider(form.id, model);
      if (data.result.ok) {
        if (data.result.warnings?.length) {
          toast.warning(`当前模型可用，但配置有提示：${data.result.warnings[0]}`);
        } else {
          toast.success(`当前模型可用：${model}，${data.result.latency_ms} ms`);
        }
      } else {
        toast.error(data.result.error || "当前模型测试失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "当前模型测试失败");
    } finally {
      setTestingModel(false);
    }
  };

  const handleToggleApiKeyVisible = async () => {
    if (showApiKey) {
      setShowApiKey(false);
      return;
    }
    if (form.id && !form.api_key.trim()) {
      setRevealingApiKey(true);
      try {
        const data = await revealImageProviderApiKey(form.id);
        if (!data.api_key) {
          toast.error("当前模型服务没有已保存的 API Key");
          return;
        }
        updateForm("api_key", data.api_key);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取 API Key 失败");
        return;
      } finally {
        setRevealingApiKey(false);
      }
    }
    setShowApiKey(true);
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-base font-semibold text-stone-950">模型服务</h2>
              <p className="mt-1 text-sm text-stone-500">配置画布可调用的 OpenAI Compatible 图片 API。</p>
            </div>
            <Button className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => openAdd("generate")}>
              <Plus className="size-4" />
              新增服务
            </Button>
          </div>

          {!isLoading ? (
            <div className="grid gap-3 md:grid-cols-2">
              <div className={`rounded-xl border px-4 py-3 ${generationProvider ? "border-stone-200 bg-white" : "border-amber-200 bg-amber-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-stone-900">生图服务</div>
                    <div className="mt-1 text-xs text-stone-500">画布文生图、图生图、编辑图片使用。</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${generationProvider ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                    {generationProvider ? "已配置" : "未配置"}
                  </span>
                </div>
                <div className="mt-3 rounded-xl border border-stone-200 bg-white/80 px-3 py-2 text-sm">
                  {generationProvider ? (
                    <div className="min-w-0">
                      <div className="truncate font-medium text-stone-900">{generationProvider.name}</div>
                      <div className="mt-1 truncate text-xs text-stone-500">{generationProvider.base_url}</div>
                      <div className="mt-1 text-xs text-stone-500">模型 {generationProvider.default_model || "-"}</div>
                    </div>
                  ) : (
                    <div className="text-sm text-amber-800">未设置，请在下方服务列表点击“设为生图”。</div>
                  )}
                </div>
              </div>

              <div className={`rounded-xl border px-4 py-3 ${reverseProvider ? "border-stone-200 bg-white" : "border-amber-200 bg-amber-50"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium text-stone-900">反推服务</div>
                    <div className="mt-1 text-xs text-stone-500">图片反推提示词专用，可使用不同 Base URL 和 Key。</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${reverseProvider ? "bg-emerald-50 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
                    {reverseProvider ? "已配置" : "未配置"}
                  </span>
                </div>
                <div className="mt-3 rounded-xl border border-stone-200 bg-white/80 px-3 py-2 text-sm">
                  {reverseProvider ? (
                    <div className="min-w-0">
                      <div className="truncate font-medium text-stone-900">{reverseProvider.name}</div>
                      <div className="mt-1 truncate text-xs text-stone-500">{reverseProvider.base_url}</div>
                      <div className="mt-1 text-xs text-stone-500">模型 {reverseProvider.default_model || "-"}</div>
                    </div>
                  ) : (
                    <div className="text-sm text-amber-800">未设置，请在下方服务列表点击“设为反推”。</div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <LoaderCircle className="size-5 animate-spin text-stone-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-8 text-center text-sm text-stone-500">
              尚未配置模型服务。添加一个 OpenAI Compatible API 后，画布才能生成图片。
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((provider) => {
                const isDefault = provider.id === defaultProviderId;
                const isReverseDefault = provider.id === defaultReverseProviderId;
                return (
                  <div key={provider.id} className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-stone-900">{provider.name}</span>
                        {isDefault ? <span className="rounded-full bg-stone-950 px-2 py-0.5 text-xs text-white">生图默认</span> : null}
                        {isReverseDefault ? <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs text-white">反推默认</span> : null}
                        {!isDefault && !isReverseDefault ? (
                          <span className={`rounded-full px-2 py-0.5 text-xs ${provider.enabled ? "bg-stone-100 text-stone-600" : "bg-rose-50 text-rose-700"}`}>
                            {provider.enabled ? "备用服务" : "已停用"}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate text-xs text-stone-500">{provider.base_url}</div>
                      <div className="mt-1 text-xs text-stone-500">模型 {provider.default_model || "-"} · API Key {provider.has_api_key ? "已保存" : "未保存"}</div>
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-stone-500">
                        {provider.latency_ms ? <span className="rounded-full bg-stone-100 px-2 py-0.5">最近 {provider.latency_ms} ms</span> : null}
                        {provider.success_count ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">成功 {provider.success_count}</span> : null}
                        {provider.error_count ? <span className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700">失败 {provider.error_count}</span> : null}
                        {provider.model_cache?.length ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">模型 {provider.model_cache.length}</span> : null}
                      </div>
                      {provider.last_error ? (
                        <div className="mt-2 line-clamp-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
                          {provider.last_error}
                        </div>
                      ) : null}
                      {provider.warnings?.length ? (
                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                          {provider.warnings[0]}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" className="h-8 rounded-xl" onClick={() => void handleTest(provider)} disabled={testingId === provider.id}>
                        {testingId === provider.id ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                        测试
                      </Button>
                      <Button variant="outline" className="h-8 rounded-xl" onClick={() => void handleSetDefault(provider, "generate")} disabled={isDefault}>
                        <Star className="size-4" />
                        设为生图
                      </Button>
                      <Button variant="outline" className="h-8 rounded-xl" onClick={() => void handleSetDefault(provider, "reverse_prompt")} disabled={isReverseDefault}>
                        <Star className="size-4" />
                        设为反推
                      </Button>
                      <Button variant="outline" className="h-8 rounded-xl" onClick={() => openEdit(provider)}>
                        <Pencil className="size-4" />
                        编辑
                      </Button>
                      <Button variant="outline" className="h-8 rounded-xl border-rose-200 text-rose-700" onClick={() => void handleDelete(provider)} disabled={deletingId === provider.id}>
                        {deletingId === provider.id ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                        删除
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}>
        <DialogContent className="max-w-2xl rounded-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "编辑模型服务" : "新增模型服务"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-stone-700">名称</label>
              <Input value={form.name} onChange={(event) => updateForm("name", event.target.value)} className="h-10 rounded-xl" />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">模型</label>
              <Input
                value={form.default_model}
                onChange={(event) => updateForm("default_model", event.target.value)}
                placeholder="gpt-image-1"
                className="h-10 rounded-xl"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <div className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-stone-50/70 p-3 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                  {modelOptions.length > 0 ? (
                    <select
                      value={modelOptions.includes(form.default_model) ? form.default_model : ""}
                      onChange={(event) => {
                        if (event.target.value) updateForm("default_model", event.target.value);
                      }}
                      className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-700 outline-none transition hover:border-stone-300"
                      title="选择已获取的模型"
                    >
                      <option value="">选择模型</option>
                      {modelOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex h-10 items-center rounded-xl border border-dashed border-stone-300 bg-white px-3 text-sm text-stone-500">
                      获取模型后，可在这里选择当前模型
                    </div>
                  )}
                </div>
                <div className="flex w-full flex-wrap gap-2 md:w-auto md:shrink-0">
                  <Button variant="outline" className="h-10 flex-1 rounded-xl md:flex-none" onClick={() => void handleFetchModels()} disabled={loadingModels || !form.id}>
                    {loadingModels ? <LoaderCircle className="size-4 animate-spin" /> : null}
                    获取模型
                  </Button>
                  <Button variant="outline" className="h-10 flex-1 rounded-xl md:flex-none" onClick={() => void handleTestCurrentModel()} disabled={testingModel || !form.id || !form.default_model.trim()}>
                    {testingModel ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                    测试当前模型
                  </Button>
                </div>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-stone-700">Base URL</label>
              <Input value={form.base_url} onChange={(event) => updateForm("base_url", event.target.value)} placeholder="https://api.example.com/v1" className="h-10 rounded-xl" />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-stone-700">API Key</label>
              <div className="relative">
                <Input
                  type={showApiKey ? "text" : "password"}
                  value={form.api_key}
                  onChange={(event) => updateForm("api_key", event.target.value)}
                  placeholder={form.id ? "留空表示不修改已保存的 Key" : "sk-..."}
                  className="h-10 rounded-xl pr-11"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-8 rounded-lg text-stone-500 hover:text-stone-950"
                  onClick={() => void handleToggleApiKeyVisible()}
                  disabled={revealingApiKey}
                  title={showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {revealingApiKey ? <LoaderCircle className="size-4 animate-spin" /> : showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </div>
            {formWarnings.length > 0 ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 md:col-span-2">
                {formWarnings.map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-stone-700">超时秒数</label>
              <Input value={form.timeout_secs} onChange={(event) => updateForm("timeout_secs", event.target.value)} placeholder="180" className="h-10 rounded-xl" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="rounded-xl" onClick={() => setDialogOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button className="rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <LoaderCircle className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
