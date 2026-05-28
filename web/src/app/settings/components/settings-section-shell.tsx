"use client";

import { Database, FileText, ImageIcon, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

export type SettingsSectionId = "base" | "accounts" | "images" | "logs";

export const settingsSections: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof Settings;
}> = [
  { id: "base", label: "基础设置", description: "系统参数、备份、用户", icon: Settings },
  { id: "accounts", label: "号池管理", description: "账号、额度、刷新", icon: Database },
  { id: "images", label: "图片管理", description: "生成图片与标签", icon: ImageIcon },
  { id: "logs", label: "日志管理", description: "调用日志与错误", icon: FileText },
];

export function SettingsSectionShell({
  activeSectionId,
  children,
  onSectionChange,
}: {
  activeSectionId: SettingsSectionId;
  children: React.ReactNode;
  onSectionChange: (sectionId: SettingsSectionId) => void;
}) {
  const activeSection = settingsSections.find((item) => item.id === activeSectionId) || settingsSections[0];

  return (
    <section className="relative -mx-4 min-h-[calc(100dvh-4.25rem)] overflow-hidden rounded-[28px] border border-stone-200/70 bg-[#f7f6f2] text-stone-900 shadow-[0_28px_100px_-48px_rgba(15,23,42,0.42)] sm:-mx-6 lg:-mx-8">
      <div className="pointer-events-none absolute inset-0 opacity-80 [background-image:linear-gradient(rgba(68,64,60,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(68,64,60,0.08)_1px,transparent_1px)] [background-size:28px_28px]" />
      <div className="relative z-10 flex min-h-[calc(100dvh-4.25rem)] flex-col">
        <div className="hide-scrollbar sticky top-0 z-30 flex flex-nowrap items-center gap-2 overflow-x-auto border-b border-stone-200/50 bg-[#f7f6f2]/88 px-3 py-3 backdrop-blur sm:px-4">
          <div className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-stone-200 bg-white/95 px-3 text-xs font-medium text-stone-700 shadow-sm backdrop-blur">
            <span className="font-semibold text-stone-950">设置工作台</span>
            <span className="hidden text-stone-300 sm:inline">/</span>
            <span className="max-w-[160px] truncate">{activeSection.label}</span>
          </div>
          <nav className="flex min-w-0 flex-nowrap items-center gap-2 lg:hidden">
            {settingsSections.map((item) => {
              const Icon = item.icon;
              const active = item.id === activeSectionId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSectionChange(item.id)}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-medium shadow-sm backdrop-blur transition",
                    active
                      ? "border-stone-950 bg-stone-950 text-white"
                      : "border-stone-200 bg-white/95 text-stone-600 hover:border-stone-300 hover:text-stone-950",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="hidden sm:inline">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className="grid min-w-0 flex-1 gap-4 px-3 py-4 sm:px-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
          <aside className="hidden lg:block lg:sticky lg:top-[4.75rem] lg:self-start">
            <div className="max-h-[calc(100dvh-6.25rem)] overflow-hidden rounded-[24px] border border-stone-200 bg-white/95 p-3 shadow-[0_24px_90px_-38px_rgba(15,23,42,0.5)] backdrop-blur">
              <div className="px-2 py-3">
                <div>
                  <div className="text-xs font-semibold tracking-[0.18em] text-stone-500 uppercase">Settings</div>
                  <div className="mt-1 text-base font-semibold tracking-tight text-stone-950">设置中心</div>
                </div>
              </div>
              <nav className="mt-1 flex max-h-[calc(100dvh-12rem)] flex-col gap-2 overflow-y-auto pr-1">
                {settingsSections.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeSectionId;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSectionChange(item.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition",
                        active ? "bg-stone-950 text-white shadow-sm" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950",
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{item.label}</span>
                        <span className={cn("block truncate text-xs", active ? "text-stone-300" : "text-stone-400")}>{item.description}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
          </aside>
          <div className="settings-workbench-content min-w-0 pb-5">{children}</div>
        </div>
      </div>
    </section>
  );
}
