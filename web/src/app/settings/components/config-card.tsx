"use client";

import { LoaderCircle, PlugZap, RefreshCcw, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_REVERSE_PROMPT_INSTRUCTION, testProxy, type ProxyTestResult } from "@/lib/api";

import { useSettingsStore } from "../store";

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const logLevelOptions = ["debug", "info", "warning", "error"];
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const configLoadError = useSettingsStore((state) => state.configLoadError);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const loadConfig = useSettingsStore((state) => state.loadConfig);
  const setImageRetentionDays = useSettingsStore((state) => state.setImageRetentionDays);
  const setImagePollTimeoutSecs = useSettingsStore((state) => state.setImagePollTimeoutSecs);
  const setImageUnacceptedTaskTimeoutSecs = useSettingsStore((state) => state.setImageUnacceptedTaskTimeoutSecs);
  const setImageStalledResultTimeoutSecs = useSettingsStore((state) => state.setImageStalledResultTimeoutSecs);
  const setImageEmptyResultRetryEnabled = useSettingsStore((state) => state.setImageEmptyResultRetryEnabled);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const setGlobalSystemPrompt = useSettingsStore((state) => state.setGlobalSystemPrompt);
  const setReversePromptInstruction = useSettingsStore((state) => state.setReversePromptInstruction);
  const setSensitiveWordsText = useSettingsStore((state) => state.setSensitiveWordsText);
  const setAIReviewField = useSettingsStore((state) => state.setAIReviewField);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-stone-400" />
        </CardContent>
      </Card>
    );
  }

  if (!config) {
    return (
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="flex items-center justify-between gap-4 p-6">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">基础参数加载失败</h2>
            <p className="mt-1 break-words text-sm text-stone-500">
              {configLoadError || "暂时无法读取系统配置，请检查后端服务或重新登录。"}
            </p>
          </div>
          <Button type="button" variant="outline" className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700" onClick={() => void loadConfig()}>
            <RefreshCcw className="size-4" />
            重试
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-4 p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm text-stone-700">全局代理</label>
            <Input
              value={String(config?.proxy || "")}
              onChange={(event) => {
                setProxy(event.target.value);
                setProxyTestResult(null);
              }}
              placeholder="http://127.0.0.1:7890"
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
            <p className="text-xs text-stone-500">留空表示不使用代理。</p>
            {proxyTestResult ? <div className={`rounded-xl border px-3 py-2 text-xs leading-6 ${proxyTestResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>{proxyTestResult.ok ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms` : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}</div> : null}
            <div className="flex justify-end">
              <Button type="button" variant="outline" className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700" onClick={() => void handleTestProxy()} disabled={isTestingProxy}>
                {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                测试代理
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">图片访问地址</label>
            <Input value={String(config?.base_url || "")} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com" className="h-10 rounded-xl border-stone-200 bg-white" />
            <p className="text-xs text-stone-500">用于生成图片结果的访问前缀地址。</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">图片自动清理</label>
            <Input value={String(config?.image_retention_days || "")} onChange={(event) => setImageRetentionDays(event.target.value)} placeholder="30" className="h-10 rounded-xl border-stone-200 bg-white" />
            <p className="text-xs text-stone-500">自动删除多少天前的本地图片。</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">图片轮询超时</label>
            <Input value={String(config?.image_poll_timeout_secs || "")} onChange={(event) => setImagePollTimeoutSecs(event.target.value)} placeholder="120" className="h-10 rounded-xl border-stone-200 bg-white" />
            <p className="text-xs text-stone-500">单位秒，等待上游图片结果的最长时间。</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">未进入生图等待</label>
            <Input value={String(config?.image_unaccepted_task_timeout_secs || "")} onChange={(event) => setImageUnacceptedTaskTimeoutSecs(event.target.value)} placeholder="20" className="h-10 rounded-xl border-stone-200 bg-white" />
            <p className="text-xs text-stone-500">远端还没确认开始生成时，最多等待多少秒后判定任务异常。</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">卡住结果等待</label>
            <Input value={String(config?.image_stalled_result_timeout_secs || "")} onChange={(event) => setImageStalledResultTimeoutSecs(event.target.value)} placeholder="60" className="h-10 rounded-xl border-stone-200 bg-white" />
            <p className="text-xs text-stone-500">远端已经确认开始生成，但图片结果迟迟不出来时的等待上限。</p>
          </div>
          <label className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
            <Checkbox checked={Boolean(config?.image_empty_result_retry_enabled ?? true)} onCheckedChange={(checked) => setImageEmptyResultRetryEnabled(Boolean(checked))} />
            图片空结果自动重试
          </label>
          <div className="space-y-3 rounded-xl border border-stone-200 bg-white px-4 py-3">
            <div>
              <label className="text-sm text-stone-700">控制台日志级别</label>
              <p className="mt-1 text-xs text-stone-500">不选择时使用默认 info / warning / error。</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {logLevelOptions.map((level) => (
                <label key={level} className="flex items-center gap-2 text-sm capitalize text-stone-700">
                  <Checkbox checked={Boolean(config?.log_levels?.includes(level))} onCheckedChange={(checked) => setLogLevel(level, Boolean(checked))} />
                  {level}
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm text-stone-700">全局附加指令</label>
            <Textarea value={String(config?.global_system_prompt || "")} onChange={(event) => setGlobalSystemPrompt(event.target.value)} placeholder="例如：先判断用户提示词是否合规；遇到违法、色情、暴力、仇恨等请求时拒绝回答。" className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none" />
            <p className="text-xs text-stone-500">每次请求都会作为 system 消息注入，可用于审核用户提示词、避免违规内容、统一约束模型行为或固定角色设定。</p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm text-stone-700">反推提示词要求</label>
              <Button
                type="button"
                variant="outline"
                className="h-8 rounded-xl border-stone-200 bg-white px-3 text-xs text-stone-600"
                onClick={() => setReversePromptInstruction(DEFAULT_REVERSE_PROMPT_INSTRUCTION)}
                disabled={String(config?.reverse_prompt_instruction || "") === DEFAULT_REVERSE_PROMPT_INSTRUCTION}
              >
                恢复默认
              </Button>
            </div>
            <Textarea value={String(config?.reverse_prompt_instruction || "")} onChange={(event) => setReversePromptInstruction(event.target.value)} placeholder={DEFAULT_REVERSE_PROMPT_INSTRUCTION} className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none" />
            <p className="text-xs text-stone-500">画布左侧「反推提示词」默认使用这段要求；保存后会对所有浏览器生效。</p>
          </div>
          <div className="space-y-2 md:col-span-2">
            <label className="text-sm text-stone-700">敏感词</label>
            <Textarea value={(config?.sensitive_words || []).join("\n")} onChange={(event) => setSensitiveWordsText(event.target.value)} placeholder="一行一个，命中即拒绝" className="min-h-28 rounded-xl border-stone-200 bg-white font-mono text-xs shadow-none" />
            <p className="text-xs text-stone-500">只要用户请求包含任意敏感词，就直接返回拒绝。</p>
          </div>
          <div className="space-y-4 rounded-xl border border-stone-200 bg-white px-4 py-3 md:col-span-2">
            <label className="flex items-center gap-3 text-sm text-stone-700">
              <Checkbox checked={Boolean(config?.ai_review?.enabled)} onCheckedChange={(checked) => setAIReviewField("enabled", Boolean(checked))} />
              启用 AI 审核
            </label>
            <p className="text-xs leading-6 text-stone-500">开启后会在请求进入生图 Provider 前先调用审核模型，审核不通过会直接拒绝。</p>
            {config?.ai_review?.enabled ? (
              <>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">Base URL</label>
                    <Input value={String(config?.ai_review?.base_url || "")} onChange={(event) => setAIReviewField("base_url", event.target.value)} placeholder="https://api.openai.com" className="h-10 rounded-xl border-stone-200 bg-white" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">API Key</label>
                    <Input value={String(config?.ai_review?.api_key || "")} onChange={(event) => setAIReviewField("api_key", event.target.value)} placeholder="sk-..." className="h-10 rounded-xl border-stone-200 bg-white" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm text-stone-700">Model</label>
                    <Input value={String(config?.ai_review?.model || "")} onChange={(event) => setAIReviewField("model", event.target.value)} placeholder="gpt-5.4-mini" className="h-10 rounded-xl border-stone-200 bg-white" />
                  </div>
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-stone-700">审核提示词</label>
                  <Textarea value={String(config?.ai_review?.prompt || "")} onChange={(event) => setAIReviewField("prompt", event.target.value)} placeholder="判断用户请求是否允许。只回答 ALLOW 或 REJECT。" className="min-h-24 rounded-xl border-stone-200 bg-white text-xs shadow-none" />
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-500">AI 审核已关闭，相关配置已折叠。</div>
            )}
          </div>
        </div>

        <div className="flex justify-end">
          <Button className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800" onClick={() => void saveConfig()} disabled={isSavingConfig}>
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
