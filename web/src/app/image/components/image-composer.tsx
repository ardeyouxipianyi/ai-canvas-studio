"use client";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
  placeholder?: string;
  submitAriaLabel?: string;
  providerOptions?: Array<{ id: string; name: string; enabled?: boolean; default_model?: string }>;
  selectedProviderId?: string;
  modelValue?: string;
  modelOptions?: string[];
  isLoadingModels?: boolean;
  onProviderChange?: (providerId: string) => void;
  onModelChange?: (model: string) => void;
  onFetchModels?: () => void | Promise<void>;
};

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
  placeholder,
  submitAriaLabel,
  providerOptions = [],
  selectedProviderId = "",
  modelValue = "",
  modelOptions = [],
  isLoadingModels = false,
  onProviderChange,
  onModelChange,
  onFetchModels,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const sizeMenuBtnRef = useRef<HTMLButtonElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const imageSizeOptions = [
    { value: "", label: "未指定", estimate: "模型自动决定" },
    { value: "1:1", label: "1:1 (正方形)", estimate: "约 1254 x 1254" },
    { value: "16:9", label: "16:9 (横版)", estimate: "约 1672 x 941" },
    { value: "4:3", label: "4:3 (横版)", estimate: "约 1448 x 1086" },
    { value: "3:4", label: "3:4 (竖版)", estimate: "约 1086 x 1448" },
    { value: "9:16", label: "9:16 (竖版)", estimate: "约 941 x 1672" },
  ];
  const activeImageSizeOption = imageSizeOptions.find((option) => option.value === imageSize) || imageSizeOptions[0];
  const imageSizeLabel = activeImageSizeOption.label;
  const imageSizeEstimate = activeImageSizeOption.estimate;
  const selectedProvider = providerOptions.find((provider) => provider.id === selectedProviderId);

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sizeMenuRef.current?.contains(event.target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group size-14 overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-16"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-[24px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] sm:rounded-[32px] sm:shadow-none">
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                placeholder ||
                (referenceImages.length > 0
                  ? "描述你希望如何修改参考图"
                  : "输入你想要生成的画面，也可直接粘贴图片")
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] max-h-[50dvh] resize-y overflow-y-auto rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-20 sm:leading-7"
            />

            <div className="rounded-b-[24px] border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:rounded-b-none sm:border-t-0 sm:bg-gradient-to-t sm:from-white sm:via-white/95 sm:to-transparent sm:px-6 sm:pb-4 sm:pt-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto rounded-full border border-stone-200 bg-stone-50/90 p-1 shadow-inner sm:w-auto sm:flex-wrap sm:gap-1.5 sm:overflow-visible">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 w-8 shrink-0 rounded-full border-stone-200 bg-white px-0 text-xs font-medium text-stone-700 shadow-sm hover:bg-stone-50"
                    onClick={onPickReferenceImage}
                    aria-label={referenceImages.length > 0 ? "添加参考图" : "上传"}
                    title={referenceImages.length > 0 ? "添加参考图" : "上传"}
                  >
                    <ImagePlus className="size-4" />
                  </Button>
                  {providerOptions.length > 0 ? (
                    <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 text-xs shadow-sm ring-1 ring-stone-200/80 sm:px-3">
                      <span className="font-medium text-stone-400">服务</span>
                      <select
                        value={selectedProviderId}
                        onChange={(event) => onProviderChange?.(event.target.value)}
                        className="h-7 max-w-[150px] border-0 bg-transparent text-xs font-semibold text-stone-800 outline-none"
                        title={selectedProvider?.name || "选择模型服务"}
                      >
                        {providerOptions.map((provider) => (
                          <option key={provider.id} value={provider.id} disabled={provider.enabled === false}>
                            {provider.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="flex h-8 shrink-0 items-center rounded-full bg-rose-50 px-2.5 text-xs font-medium text-rose-700 ring-1 ring-rose-100 sm:px-3">
                      未配置模型服务
                    </div>
                  )}
                  {onModelChange ? (
                    <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 text-xs shadow-sm ring-1 ring-stone-200/80 sm:px-3">
                      <span className="font-medium text-stone-400">模型</span>
                      <input
                        value={modelValue}
                        onChange={(event) => onModelChange(event.target.value)}
                        placeholder={selectedProvider?.default_model || "model"}
                        className="h-7 w-[118px] border-0 bg-transparent px-0 text-xs font-semibold text-stone-800 outline-none"
                      />
                      {modelOptions.length > 0 ? (
                        <select
                          value={modelOptions.includes(modelValue) ? modelValue : ""}
                          onChange={(event) => {
                            if (event.target.value) onModelChange(event.target.value);
                          }}
                          className="h-6 max-w-[138px] shrink-0 rounded-full border border-stone-200 bg-stone-50 px-2 text-[11px] font-medium text-stone-700 outline-none transition hover:bg-stone-100"
                          title="选择已获取的模型"
                        >
                          <option value="">选择模型</option>
                          {modelOptions.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      {onFetchModels ? (
                        <button
                          type="button"
                          className="inline-flex h-6 shrink-0 items-center rounded-full bg-stone-100 px-2 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => void onFetchModels()}
                          disabled={isLoadingModels || !selectedProviderId}
                          title="从当前模型服务获取模型列表"
                        >
                          {isLoadingModels ? <LoaderCircle className="mr-1 size-3 animate-spin" /> : null}
                          获取
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {activeTaskCount > 0 && (
                    <div className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2.5 text-xs font-medium text-amber-700 ring-1 ring-amber-100 sm:gap-1.5 sm:px-3">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 个任务处理中</span>
                    </div>
                  )}
                  <div className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 shadow-sm ring-1 ring-stone-200/80 sm:gap-2 sm:px-3">
                    <span className="text-xs font-medium text-stone-400">张数</span>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max="100"
                      step="1"
                      value={imageCount}
                      onChange={(event) => onImageCountChange(event.target.value)}
                      className="h-7 w-[34px] border-0 bg-transparent px-0 text-center text-xs font-semibold text-stone-800 shadow-none focus-visible:ring-0 sm:w-[44px]"
                    />
                  </div>
                  <div className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white px-2.5 text-xs shadow-sm ring-1 ring-stone-200/80 sm:gap-2 sm:px-3">
                    <span className="font-medium text-stone-400">比例</span>
                    <div className="flex min-w-0 items-center">
                      <button
                        ref={sizeMenuBtnRef}
                        type="button"
                        className="flex h-7 w-auto min-w-0 items-center gap-1 bg-transparent text-left text-xs font-semibold text-stone-800"
                        onClick={() => {
                          if (!isSizeMenuOpen && sizeMenuBtnRef.current) {
                            const rect = sizeMenuBtnRef.current.getBoundingClientRect();
                            const menuWidth = Math.min(224, window.innerWidth - 32);
                            setSizeMenuPos({ top: rect.top - 8, left: Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16)) });
                          }
                          setIsSizeMenuOpen((open) => !open);
                        }}
                      >
                        <span className="truncate">{imageSizeLabel}</span>
                        <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                      </button>
                    </div>
                    {isSizeMenuOpen ? (
                      <div
                        ref={sizeMenuRef}
                        className="fixed z-[80] max-h-[45dvh] overflow-y-auto rounded-3xl border border-white/80 bg-white p-2 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.35)]"
                        style={{
                          top: sizeMenuPos.top,
                          left: sizeMenuPos.left,
                          transform: "translateY(-100%)",
                          width: "min(224px, calc(100vw - 2rem))",
                        }}
                      >
                        {imageSizeOptions.map((option) => {
                          const active = option.value === imageSize;
                          return (
                            <button
                              key={option.label}
                              type="button"
                              className={cn(
                                "flex w-full items-center justify-between rounded-2xl px-3 py-2 text-left text-sm text-stone-700 transition hover:bg-stone-100",
                                active && "bg-stone-100 font-medium text-stone-950",
                              )}
                              onClick={() => {
                                onImageSizeChange(option.value);
                                setIsSizeMenuOpen(false);
                              }}
                            >
                              <span className="min-w-0">
                                <span className="block truncate">{option.label}</span>
                                <span className="block truncate text-xs text-stone-400">{option.estimate}</span>
                              </span>
                              {active ? <Check className="size-4" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
                  aria-label={submitAriaLabel || (referenceImages.length > 0 ? "编辑图片" : "生成图片")}
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

