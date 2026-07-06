"use client";

import { CheckCircle2, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  deleteImageProvider,
  fetchImageProviderModelsForConfig,
  fetchImageProviders,
  revealImageProviderApiKey,
  saveImageProvider,
  testImageProviderForConfig,
  type ImageProvider,
  type ImageProviderCapabilities,
  type ImageProviderInput,
  type ImageProviderListResponse,
} from "@/lib/api";

type ProviderPurpose = "generate" | "reverse_prompt";
type PurposeRecord<T> = Record<ProviderPurpose, T>;

type ProviderForm = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  default_model: string;
  provider_default_model: string;
  default_reverse_prompt_model: string;
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
  provider_default_model: "gpt-image-1",
  default_reverse_prompt_model: "gpt-image-1",
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

const PURPOSE_CONFIG: PurposeRecord<{
  label: string;
  description: string;
  defaultModel: string;
  saveLabel: string;
  savedToast: string;
}> = {
  generate: {
    label: "生图服务",
    description: "画布文生图、图生图、编辑图片使用。",
    defaultModel: "gpt-image-1",
    saveLabel: "保存为生图服务",
    savedToast: "生图服务已保存",
  },
  reverse_prompt: {
    label: "反推服务",
    description: "图片反推提示词专用，可使用不同 Base URL 和 Key。",
    defaultModel: "gpt-5.3-mini",
    saveLabel: "保存为反推服务",
    savedToast: "反推服务已保存",
  },
};

const initialDirtyState: PurposeRecord<boolean> = {
  generate: false,
  reverse_prompt: false,
};

function looksLikeUrl(value: string) {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/[ /。.，,、；;]+$/g, "");
}

function defaultFormForPurpose(purpose: ProviderPurpose): ProviderForm {
  const config = PURPOSE_CONFIG[purpose];
  return {
    ...emptyForm,
    name: config.label,
    default_model: config.defaultModel,
    provider_default_model: config.defaultModel,
    default_reverse_prompt_model: config.defaultModel,
    capabilities:
      purpose === "reverse_prompt"
        ? { generate: false, edit: true, reverse_prompt: true }
        : { generate: true, edit: true, reverse_prompt: false },
  };
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

function providerToForm(provider: ImageProvider, purpose: ProviderPurpose): ProviderForm {
  const providerDefaultModel = provider.default_model || PURPOSE_CONFIG.generate.defaultModel;
  const reversePromptModel = provider.default_reverse_prompt_model || providerDefaultModel;
  const slotModel = purpose === "reverse_prompt" ? reversePromptModel : providerDefaultModel;

  return {
    id: provider.id,
    name: provider.name,
    base_url: provider.base_url,
    api_key: "",
    default_model: slotModel,
    provider_default_model: providerDefaultModel,
    default_reverse_prompt_model: reversePromptModel,
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

function formToInput(form: ProviderForm, purpose: ProviderPurpose, defaultReverseProviderId = ""): ImageProviderInput {
  const slotModel = form.default_model.trim();
  const capabilities =
    purpose === "reverse_prompt"
      ? { ...form.capabilities, edit: true, reverse_prompt: true }
      : {
          ...form.capabilities,
          generate: true,
          edit: true,
          reverse_prompt: form.capabilities.reverse_prompt || form.id === defaultReverseProviderId,
        };

  return {
    id: form.id || undefined,
    name: form.name.trim() || PURPOSE_CONFIG[purpose].label,
    type: "openai_compatible",
    enabled: form.enabled,
    base_url: normalizeBaseUrl(form.base_url),
    api_key: form.api_key.trim(),
    keep_api_key: Boolean(form.id && !form.api_key.trim()),
    default_model: purpose === "reverse_prompt" ? form.provider_default_model.trim() || slotModel : slotModel,
    default_reverse_prompt_model:
      purpose === "reverse_prompt"
        ? slotModel
        : form.id === defaultReverseProviderId
          ? form.default_reverse_prompt_model.trim() || slotModel
          : undefined,
    default_size: form.default_size.trim(),
    default_quality: form.default_quality.trim() || "auto",
    timeout_secs: Number(form.timeout_secs) || 180,
    capabilities,
    make_default: purpose === "generate",
    make_reverse_default: purpose === "reverse_prompt",
  };
}

export function ImageProvidersCard() {
  const [items, setItems] = useState<ImageProvider[]>([]);
  const [defaultProviderId, setDefaultProviderId] = useState("");
  const [defaultReverseProviderId, setDefaultReverseProviderId] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [quickForms, setQuickForms] = useState<PurposeRecord<ProviderForm>>({
    generate: defaultFormForPurpose("generate"),
    reverse_prompt: defaultFormForPurpose("reverse_prompt"),
  });
  const [quickModelOptions, setQuickModelOptions] = useState<PurposeRecord<string[]>>({
    generate: [],
    reverse_prompt: [],
  });
  const [quickSaving, setQuickSaving] = useState<ProviderPurpose | null>(null);
  const [quickLoadingModels, setQuickLoadingModels] = useState<ProviderPurpose | null>(null);
  const [quickTesting, setQuickTesting] = useState<ProviderPurpose | null>(null);
  const [quickShowApiKey, setQuickShowApiKey] = useState<PurposeRecord<boolean>>({
    generate: false,
    reverse_prompt: false,
  });
  const [dirtyPurposes, setDirtyPurposes] = useState<PurposeRecord<boolean>>(initialDirtyState);
  const [cleaningStaleProviders, setCleaningStaleProviders] = useState(false);
  const [quickRevealingApiKey, setQuickRevealingApiKey] = useState<ProviderPurpose | null>(null);

  const enabledProviders = items.filter((provider) => provider.enabled);
  const generationProvider = enabledProviders.find((provider) => provider.id === defaultProviderId);
  const reverseProvider = enabledProviders.find((provider) => provider.id === defaultReverseProviderId);
  const activeProviderIds = new Set([defaultProviderId, defaultReverseProviderId].filter(Boolean));
  const staleProviders = items.filter((provider) => !activeProviderIds.has(provider.id));

  const syncProviderState = (data: ImageProviderListResponse, savedPurpose?: ProviderPurpose) => {
    const nextDefaultProviderId = data.default_provider_id || "";
    const nextDefaultReverseProviderId = data.default_reverse_provider_id || "";
    const nextGenerationProvider = data.items.find((provider) => provider.id === nextDefaultProviderId && provider.enabled);
    const nextReverseProvider = data.items.find((provider) => provider.id === nextDefaultReverseProviderId && provider.enabled);
    const nextForms: PurposeRecord<ProviderForm> = {
      generate: nextGenerationProvider ? providerToForm(nextGenerationProvider, "generate") : defaultFormForPurpose("generate"),
      reverse_prompt: nextReverseProvider ? providerToForm(nextReverseProvider, "reverse_prompt") : defaultFormForPurpose("reverse_prompt"),
    };
    const nextOptions: PurposeRecord<string[]> = {
      generate: nextGenerationProvider?.model_cache || [],
      reverse_prompt: nextReverseProvider?.model_cache || [],
    };

    setItems(data.items);
    setDefaultProviderId(nextDefaultProviderId);
    setDefaultReverseProviderId(nextDefaultReverseProviderId);
    setQuickForms((current) => ({
      generate: savedPurpose === "reverse_prompt" ? current.generate : nextForms.generate,
      reverse_prompt: savedPurpose === "generate" ? current.reverse_prompt : nextForms.reverse_prompt,
    }));
    setQuickModelOptions((current) => ({
      generate: savedPurpose === "reverse_prompt" ? current.generate : nextOptions.generate,
      reverse_prompt: savedPurpose === "generate" ? current.reverse_prompt : nextOptions.reverse_prompt,
    }));
    setDirtyPurposes((current) => ({
      generate: savedPurpose === "generate" || !savedPurpose ? false : current.generate,
      reverse_prompt: savedPurpose === "reverse_prompt" || !savedPurpose ? false : current.reverse_prompt,
    }));
    setQuickShowApiKey((current) => ({
      generate: savedPurpose === "generate" || !savedPurpose ? false : current.generate,
      reverse_prompt: savedPurpose === "reverse_prompt" || !savedPurpose ? false : current.reverse_prompt,
    }));
  };

  const syncAllProviderState = (data: ImageProviderListResponse) => {
    syncProviderState(data);
    setDirtyPurposes(initialDirtyState);
    setQuickShowApiKey(initialDirtyState);
  };

  const updateProviderStateAfterSave = (data: ImageProviderListResponse, purpose: ProviderPurpose) => {
    syncProviderState(data, purpose);
    setDirtyPurposes((current) => ({ ...current, [purpose]: false }));
    setQuickShowApiKey((current) => ({ ...current, [purpose]: false }));
  };

  const markPurposeDirty = (purpose: ProviderPurpose) => {
    setDirtyPurposes((current) => ({
      ...current,
      [purpose]: true,
    }));
  };

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await fetchImageProviders();
      syncAllProviderState(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载模型服务失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const updateQuickForm = <K extends keyof ProviderForm>(purpose: ProviderPurpose, key: K, value: ProviderForm[K]) => {
    markPurposeDirty(purpose);
    setQuickForms((current) => ({
      ...current,
      [purpose]: { ...current[purpose], [key]: value },
    }));
  };

  const validateForm = (providerForm: ProviderForm) => {
    if (providerForm.api_key.trim() && looksLikeUrl(providerForm.api_key)) {
      toast.error("API Key 不能填写 URL，请填写真正的密钥");
      return false;
    }
    if (!normalizeBaseUrl(providerForm.base_url)) {
      toast.error("请先填写 Base URL");
      return false;
    }
    if (!providerForm.id && !providerForm.api_key.trim()) {
      toast.error("请先填写 API Key");
      return false;
    }
    if (!providerForm.default_model.trim()) {
      toast.error("请先填写模型");
      return false;
    }
    return true;
  };

  const handleQuickSave = async (purpose: ProviderPurpose) => {
    const currentForm = quickForms[purpose];
    if (!validateForm(currentForm)) return;
    setQuickSaving(purpose);
    try {
      const data = await saveImageProvider(formToInput(currentForm, purpose, defaultReverseProviderId));
      updateProviderStateAfterSave(data, purpose);
      toast.success(PURPOSE_CONFIG[purpose].savedToast);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存模型服务失败");
    } finally {
      setQuickSaving(null);
    }
  };

  const handleQuickTest = async (purpose: ProviderPurpose) => {
    const currentForm = quickForms[purpose];
    if (!validateForm(currentForm)) return;
    setQuickTesting(purpose);
    try {
      const data = await testImageProviderForConfig({
        ...formToInput(currentForm, purpose, defaultReverseProviderId),
        model: currentForm.default_model.trim(),
      });
      if (data.result.ok) {
        if (data.result.warnings?.length) {
          toast.warning(`当前模型可用，但配置有提示：${data.result.warnings[0]}`);
        } else {
          toast.success(`当前模型可用：${currentForm.default_model}，${data.result.latency_ms} ms`);
        }
      } else {
        toast.error(data.result.error || "当前模型测试失败");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "当前模型测试失败");
    } finally {
      setQuickTesting(null);
    }
  };

  const fetchModelsForForm = async (providerForm: ProviderForm, purpose: ProviderPurpose) => {
    if (providerForm.api_key.trim() && looksLikeUrl(providerForm.api_key)) {
      toast.error("API Key 不能填写 URL，请填写真正的密钥");
      return null;
    }
    if (!normalizeBaseUrl(providerForm.base_url)) {
      toast.error("请先填写 Base URL");
      return null;
    }
    if (!providerForm.id && !providerForm.api_key.trim()) {
      toast.error("请先填写 API Key");
      return null;
    }
    const data = await fetchImageProviderModelsForConfig(formToInput(providerForm, purpose, defaultReverseProviderId));
    return Array.from(new Set((data.items || []).map((item) => String(item || "").trim()).filter(Boolean)));
  };

  const handleQuickFetchModels = async (purpose: ProviderPurpose) => {
    const currentForm = quickForms[purpose];
      setQuickLoadingModels(purpose);
    try {
      const models = await fetchModelsForForm(currentForm, purpose);
      if (!models) return;
      setQuickModelOptions((current) => ({ ...current, [purpose]: models }));
      if (models.length === 0) {
        toast.error("没有获取到模型列表");
        return;
      }
      updateQuickForm(purpose, "default_model", currentForm.default_model.trim() || models[0]);
      toast.success(`已获取 ${models.length} 个模型`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "获取模型列表失败");
    } finally {
      setQuickLoadingModels(null);
    }
  };

  const handleToggleQuickApiKeyVisible = async (purpose: ProviderPurpose) => {
    if (quickShowApiKey[purpose]) {
      setQuickShowApiKey((current) => ({ ...current, [purpose]: false }));
      return;
    }
    const currentForm = quickForms[purpose];
    if (currentForm.id && !currentForm.api_key.trim()) {
      setQuickRevealingApiKey(purpose);
      try {
        const data = await revealImageProviderApiKey(currentForm.id);
        if (!data.api_key) {
          toast.error("当前模型服务没有已保存的 API Key");
          return;
        }
        updateQuickForm(purpose, "api_key", data.api_key);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取 API Key 失败");
        return;
      } finally {
        setQuickRevealingApiKey(null);
      }
    }
    setQuickShowApiKey((current) => ({ ...current, [purpose]: true }));
  };

  const handleCleanStaleProviders = async () => {
    if (staleProviders.length === 0 || cleaningStaleProviders) return;
    const confirmed = window.confirm(`确定删除 ${staleProviders.length} 个旧服务配置吗？当前生图/反推服务不会删除。`);
    if (!confirmed) return;

    setCleaningStaleProviders(true);
    try {
      let latest: ImageProviderListResponse | null = null;
      for (const provider of staleProviders) {
        latest = await deleteImageProvider(provider.id);
      }
      if (latest) {
        syncAllProviderState(latest);
      } else {
        await load();
      }
      toast.success("旧服务配置已清理");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清理旧服务失败");
    } finally {
      setCleaningStaleProviders(false);
    }
  };

  const renderModelPicker = (
    providerForm: ProviderForm,
    options: string[],
    onModelChange: (value: string) => void,
    onFetchModels: () => void,
    loading: boolean,
  ) => (
    <div className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-stone-50/70 p-3 md:flex-row md:items-center">
      <div className="min-w-0 flex-1">
        {options.length > 0 ? (
          <select
            value={options.includes(providerForm.default_model) ? providerForm.default_model : ""}
            onChange={(event) => {
              if (event.target.value) onModelChange(event.target.value);
            }}
            className="h-10 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm text-stone-700 outline-none transition hover:border-stone-300"
            title="选择已获取的模型"
          >
            <option value="">选择模型</option>
            {options.map((model) => (
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
      <Button variant="outline" className="h-10 rounded-xl" onClick={onFetchModels} disabled={loading}>
        {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
        获取模型
      </Button>
    </div>
  );

  const renderQuickProviderForm = (purpose: ProviderPurpose) => {
    const currentForm = quickForms[purpose];
    const config = PURPOSE_CONFIG[purpose];
    const isReverse = purpose === "reverse_prompt";
    const provider = isReverse ? reverseProvider : generationProvider;
    const warnings = providerFormWarnings(currentForm);
    const showKey = quickShowApiKey[purpose];
    const isDirty = dirtyPurposes[purpose];
    const isSaving = quickSaving === purpose;
    const isTesting = quickTesting === purpose;
    const isLoadingModelsForPurpose = quickLoadingModels === purpose;
    const isRevealing = quickRevealingApiKey === purpose;
    const options = quickModelOptions[purpose];
    const statusLabel = isDirty ? "未保存" : provider ? "已配置" : "未配置";
    const statusClass = isDirty
      ? "bg-amber-100 text-amber-800"
      : provider
        ? "bg-emerald-50 text-emerald-700"
        : "bg-amber-100 text-amber-800";

    return (
      <div className={`rounded-xl border px-4 py-4 ${provider ? "border-stone-200 bg-white" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-stone-900">{config.label}</div>
            <div className="mt-1 text-xs text-stone-500">{config.description}</div>
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusClass}`}>{statusLabel}</span>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-600">名称</label>
            <Input value={currentForm.name} onChange={(event) => updateQuickForm(purpose, "name", event.target.value)} className="h-10 rounded-xl bg-white" />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-600">模型</label>
            <Input
              value={currentForm.default_model}
              onChange={(event) => updateQuickForm(purpose, "default_model", event.target.value)}
              placeholder={config.defaultModel}
              className="h-10 rounded-xl bg-white"
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            {renderModelPicker(
              currentForm,
              options,
              (value) => updateQuickForm(purpose, "default_model", value),
              () => void handleQuickFetchModels(purpose),
              isLoadingModelsForPurpose,
            )}
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-xs font-medium text-stone-600">Base URL</label>
            <Input
              value={currentForm.base_url}
              onChange={(event) => updateQuickForm(purpose, "base_url", event.target.value)}
              placeholder="https://api.example.com/v1"
              className="h-10 rounded-xl bg-white"
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-600">API Key</label>
            <div className="relative">
              <Input
                type={showKey ? "text" : "password"}
                value={currentForm.api_key}
                onChange={(event) => updateQuickForm(purpose, "api_key", event.target.value)}
                placeholder={currentForm.id ? "留空不改 Key" : "sk-..."}
                className="h-10 rounded-xl bg-white pr-11"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 size-8 rounded-lg text-stone-500 hover:text-stone-950"
                onClick={() => void handleToggleQuickApiKeyVisible(purpose)}
                disabled={isRevealing}
                title={showKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {isRevealing ? <LoaderCircle className="size-4 animate-spin" /> : showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-stone-600">超时秒数</label>
            <Input
              value={currentForm.timeout_secs}
              onChange={(event) => updateQuickForm(purpose, "timeout_secs", event.target.value)}
              placeholder="180"
              className="h-10 rounded-xl bg-white"
            />
          </div>
          {warnings.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800 md:col-span-2">
              {warnings.map((warning) => (
                <div key={warning}>{warning}</div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="outline" className="h-9 rounded-xl" onClick={() => void handleQuickTest(purpose)} disabled={isTesting}>
            {isTesting ? <LoaderCircle className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            测试
          </Button>
          <Button className="h-9 rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleQuickSave(purpose)} disabled={isSaving || !isDirty}>
            {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {config.saveLabel}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-5 p-6">
        <div>
          <h2 className="text-base font-semibold text-stone-950">模型服务</h2>
          <p className="mt-1 text-sm text-stone-500">配置画布可调用的 OpenAI Compatible 图片 API。</p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-stone-400" />
          </div>
        ) : (
          <>
            <div className="grid gap-3 xl:grid-cols-2">
              {renderQuickProviderForm("generate")}
              {renderQuickProviderForm("reverse_prompt")}
            </div>
            {staleProviders.length > 0 ? (
              <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 md:flex-row md:items-center md:justify-between">
                <div>
                  检测到 {staleProviders.length} 个旧服务配置，当前页面不会使用它们。
                </div>
                <Button variant="outline" className="h-8 rounded-xl bg-white" onClick={() => void handleCleanStaleProviders()} disabled={cleaningStaleProviders}>
                  {cleaningStaleProviders ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  清理旧服务
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
