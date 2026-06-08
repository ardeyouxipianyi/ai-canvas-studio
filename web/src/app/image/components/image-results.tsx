"use client";

import { useState } from "react";
import { Clock3, Download, LoaderCircle, RotateCcw, Sparkles, Trash2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryFailedImages: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onCancelTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onClearFailedRecords: (conversationId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  return image.url || "";
}

async function downloadStoredImage(image: StoredImage, index: number, fileName?: string) {
  let blob: Blob;
  if (image.b64_json) {
    const binary = atob(image.b64_json);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: "image/png" });
  } else if (image.url) {
    const res = await fetch(image.url);
    blob = await res.blob();
  } else {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || `image-${index + 1}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function downloadTurnImages(images: StoredImage[], turnIndex: number) {
  const downloadableImages = images.filter((image) => image.status === "success" && getStoredImageSrc(image));

  for (let index = 0; index < downloadableImages.length; index += 1) {
    await downloadStoredImage(downloadableImages[index], index, `turn-${turnIndex + 1}-image-${index + 1}.png`);
    await new Promise((resolve) => window.setTimeout(resolve, 160));
  }
}

function formatImageError(message?: string) {
  const text = String(message || "").trim();
  const lowerText = text.toLowerCase();

  if (!text) {
    return "生成失败";
  }
  if (text === "任务已取消") {
    return text;
  }
  if (lowerText.includes("no available image quota")) {
    return "当前模型服务没有可用图片额度，请检查 Provider 配置或上游余额。";
  }
  if (lowerText.includes("image task returned no image data") || text.includes("未返回图片数据")) {
    return "上游没有返回图片数据，请稍后重试。";
  }
  if (lowerText.includes("upstream image connection failed")) {
    return "上游图片连接失败，请稍后重试。";
  }
  if (lowerText.includes("image generation was rejected") || lowerText.includes("content_policy_violation")) {
    return "图片请求被上游安全策略拒绝，请调整提示词后重试。";
  }
  if (lowerText.includes("image task failed")) {
    return "图片任务执行失败，请稍后重试。";
  }
  if (text.includes("服务已重启") || text.includes("已中断")) {
    return "服务重启导致任务中断，请重新生成。";
  }
  return text;
}

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryFailedImages,
  onRetryImage,
  onCancelTurn,
  onClearFailedRecords,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[260px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl">
          <h1
            className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            在同一窗口里保留本地历史与任务状态，并从已有结果图继续发起新的无状态编辑。
          </p>
        </div>
      </div>
    );
  }

  const failedImageCount = selectedConversation.turns.reduce(
    (sum, turn) => sum + (turn.resultsDeleted ? 0 : turn.images.filter((image) => image.status === "error").length),
    0,
  );

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {failedImageCount > 0 ? (
        <div className="sticky top-0 z-10 flex justify-end">
          <button
            type="button"
            onClick={() => void onClearFailedRecords(selectedConversation.id)}
            className="inline-flex items-center gap-1.5 rounded-full border border-rose-100 bg-white/95 px-3 py-1.5 text-xs font-medium text-rose-600 shadow-sm backdrop-blur transition hover:bg-rose-50"
          >
            <Trash2 className="size-3.5" />
            清理失败记录 ({failedImageCount})
          </button>
        </div>
      ) : null}
      {selectedConversation.turns.map((turn, turnIndex) => {
        const turnFailedCount = turn.resultsDeleted ? 0 : turn.images.filter((image) => image.status === "error").length;
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
        }));
        const successfulTurnImages = turn.images.flatMap((image) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
                  dimensions: imageDimensions[image.id],
                },
              ]
            : [];
        });

        return (
          <div
            key={turn.id}
            data-image-turn-id={turn.id}
            className="scroll-mt-4 flex flex-col gap-3 sm:scroll-mt-6 sm:gap-4"
          >
            {!turn.promptDeleted ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] px-1 py-1 text-[14px] leading-6 text-stone-900 sm:max-w-[82%] sm:text-[15px] sm:leading-7">
                  <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-stone-400 sm:mb-2">
                    <span>第 {turnIndex + 1} 轮</span>
                    <span>
                      {turn.mode === "edit" ? "编辑图" : "文生图"}
                    </span>
                    <span>{getTurnStatusLabel(turn.status)}</span>
                    <span>{formatConversationTime(turn.createdAt)}</span>
                  </div>
                  <div className="text-right">{turn.prompt}</div>
                  <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      复用配置
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePrompt(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除提示词记录"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!turn.resultsDeleted ? (
              <div className="flex justify-start">
                <div className="w-full p-1">
                  {turn.referenceImages.length > 0 ? (
                    <div className="mb-4 flex flex-col items-end">
                      <div className="mb-3 text-xs font-medium text-stone-500">本轮参考图</div>
                      <div className="flex flex-wrap justify-end gap-3">
                        {turn.referenceImages.map((image, index) => (
                          <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-end gap-2">
                            <button
                              type="button"
                              onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                              className="group relative h-24 w-24 overflow-hidden border border-stone-200/80 bg-stone-100/60 text-left transition hover:border-stone-300"
                              aria-label={`预览参考图 ${image.name || index + 1}`}
                            >
                              <img
                                src={image.dataUrl}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                              />
                            </button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="rounded-full border-stone-200 bg-white text-stone-700 hover:bg-stone-50"
                              onClick={() => onContinueEdit(selectedConversation.id, image)}
                            >
                              <Sparkles className="size-4" />
                              加入编辑
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                    <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                    {turn.status === "queued" ? (
                      <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700">等待当前对话中的前序任务完成</span>
                    ) : null}
                    {turn.status === "queued" || turn.status === "generating" ? (
                      <button
                        type="button"
                        onClick={() => void onCancelTurn(selectedConversation.id, turn.id)}
                        className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-3 py-1 font-medium text-rose-600 transition hover:bg-rose-100"
                      >
                        <XCircle className="size-3.5" />
                        取消任务
                      </button>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:block sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
                    {turn.images.map((image, index) => {
                      const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                      if (image.status === "success" && imageSrc) {
                        const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
                        const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
                        const dimensions = imageDimensions[image.id];
                        const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                        return (
                          <div
                            key={image.id}
                            className="break-inside-avoid"
                          >
                            <button
                              type="button"
                              onClick={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-xl sm:aspect-auto"
                            >
                              <img
                                src={imageSrc}
                                alt={`Generated result ${index + 1}`}
                                className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:h-auto sm:object-contain"
                                onLoad={(event) => {
                                  updateImageDimensions(
                                    image.id,
                                    event.currentTarget.naturalWidth,
                                    event.currentTarget.naturalHeight,
                                  );
                                }}
                              />
                            </button>
                            <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-3 sm:text-xs">
                              <div className="min-w-0 text-stone-500">
                                <span>结果 {index + 1}</span>
                                {imageMeta ? <span className="block text-stone-400 sm:ml-2 sm:inline">{imageMeta}</span> : null}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:h-8 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => onContinueEdit(selectedConversation.id, image)}
                                  aria-label="加入编辑"
                                >
                                  <Sparkles className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">加入编辑</span>
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 rounded-full border-stone-200 bg-white px-0 text-[10px] text-stone-700 hover:bg-stone-50 sm:h-8 sm:w-fit sm:px-3 sm:text-xs"
                                  onClick={() => void downloadStoredImage(image, index)}
                                  aria-label="下载"
                                >
                                  <Download className="size-3 sm:size-4" />
                                  <span className="hidden sm:inline">下载</span>
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (image.status === "error") {
                        return (
                          <div
                            key={image.id}
                            className={cn(
                              "break-inside-avoid overflow-hidden rounded-xl border border-rose-200 bg-rose-50 sm:rounded-none",
                              "aspect-square",
                              turn.size === "1:1" && "sm:aspect-square",
                              turn.size === "16:9" && "sm:aspect-video",
                              turn.size === "9:16" && "sm:aspect-[9/16]",
                              turn.size === "4:3" && "sm:aspect-[4/3]",
                              turn.size === "3:4" && "sm:aspect-[3/4]",
                              !["1:1", "16:9", "9:16", "4:3", "3:4"].includes(turn.size) && "sm:aspect-square",
                            )}
                          >
                            <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1.5 px-2 py-2 text-center text-[11px] leading-4 text-rose-600 sm:gap-3 sm:px-6 sm:py-8 sm:text-sm sm:leading-6">
                              <span className="line-clamp-2 sm:line-clamp-none">{formatImageError(image.error)}</span>
                              <button
                                type="button"
                                onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-rose-600 shadow-sm transition hover:bg-rose-100 sm:px-3 sm:text-xs"
                              >
                                重新生成这一张
                              </button>
                            </div>
                          </div>
                        );
                      }

                      const rawProgress = Number(image.progress ?? (turn.status === "queued" ? 0 : 15));
                      const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, Math.round(rawProgress))) : 0;
                      const progressText = image.progressMessage || (turn.status === "queued" ? "排队中" : "处理中");

                      return (
                        <div
                          key={image.id}
                          className={cn(
                            "break-inside-avoid overflow-hidden rounded-xl border border-stone-200/80 bg-stone-100/80 sm:rounded-none",
                            turn.size === "1:1" && "aspect-square",
                            turn.size === "16:9" && "aspect-video",
                            turn.size === "9:16" && "aspect-[9/16]",
                            turn.size === "4:3" && "aspect-[4/3]",
                            turn.size === "3:4" && "aspect-[3/4]",
                            !["1:1", "16:9", "9:16", "4:3", "3:4"].includes(turn.size) && "aspect-square",
                          )}
                        >
                          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 py-3 text-center text-stone-500 sm:gap-3 sm:px-6 sm:py-8">
                            <div className="rounded-full bg-white p-2 shadow-sm sm:p-3">
                              {turn.status === "queued" ? (
                                <Clock3 className="size-4 sm:size-5" />
                              ) : (
                                <LoaderCircle className="size-4 animate-spin sm:size-5" />
                              )}
                            </div>
                            <div className="w-full max-w-40 space-y-1">
                              <p className="text-[10px] leading-4 sm:text-sm">{progressText}</p>
                              <div className="h-1.5 overflow-hidden rounded-full bg-white shadow-inner">
                                <div className="h-full rounded-full bg-stone-700 transition-all" style={{ width: `${progress}%` }} />
                              </div>
                              <p className="text-[10px] text-stone-400">{progress}%</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {turn.status === "error" && turn.error ? (
                    <div className="mt-4 border-l-2 border-amber-300 bg-amber-50/70 px-4 py-3 text-sm leading-6 text-amber-700">
                      {formatImageError(turn.error)}
                    </div>
                  ) : null}

                  <div className="mt-3 flex items-center gap-1.5 text-[11px] sm:mt-4">
                    {successfulTurnImages.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => void downloadTurnImages(turn.images, turnIndex)}
                        className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-500 transition hover:bg-stone-200 hover:text-stone-900"
                      >
                        <Download className="size-3" />
                        下载本轮全部 ({successfulTurnImages.length})
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                      className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-500 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      <RotateCcw className="size-3" />
                      全部重新生成
                    </button>
                    {turnFailedCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => void onRetryFailedImages(selectedConversation.id, turn.id)}
                        className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-1 font-medium text-rose-600 transition hover:bg-rose-100"
                      >
                        <RotateCcw className="size-3" />
                        只重试失败 ({turnFailedCount})
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                      className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                      aria-label="删除生成结果"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

function formatBase64ImageSize(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
