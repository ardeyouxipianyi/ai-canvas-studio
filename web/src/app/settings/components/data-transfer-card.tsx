"use client";

import { DatabaseBackup, Download, FileArchive, FolderOpen, LoaderCircle, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import webConfig from "@/constants/common-env";
import { importDataPackage, type BackupInclude } from "@/lib/api";
import { getStoredAuthKey } from "@/store/auth";

const transferItems: Array<{ key: keyof BackupInclude; label: string; note: string }> = [
  { key: "config", label: "系统配置", note: "基础设置、管理员密码等" },
  { key: "accounts_snapshot", label: "账号池", note: "所有账号与额度状态" },
  { key: "auth_keys_snapshot", label: "用户密钥", note: "普通用户访问密钥" },
  { key: "image_tasks", label: "图片任务", note: "画图任务记录" },
  { key: "image_canvas", label: "画布项目", note: "画布节点与连接关系" },
  { key: "images", label: "生成图片", note: "本地生成图片与标签" },
  { key: "logs", label: "运行日志", note: "调用日志与账号事件" },
  { key: "register", label: "注册配置", note: "注册模块配置" },
  { key: "cpa", label: "CPA 配置", note: "CPA 连接配置" },
  { key: "sub2api", label: "Sub2API 配置", note: "Sub2API 连接配置" },
];

const defaultInclude: BackupInclude = {
  config: true,
  register: true,
  cpa: true,
  sub2api: true,
  logs: true,
  image_tasks: true,
  image_canvas: true,
  accounts_snapshot: true,
  auth_keys_snapshot: true,
  images: false,
};

function getFilenameFromContentDisposition(value: string | null) {
  const header = String(value || "").trim();
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plainMatch?.[1] || "";
}

function selectedCount(include: BackupInclude) {
  return transferItems.filter((item) => include[item.key]).length;
}

function setAllInclude(value: boolean): BackupInclude {
  const next = { ...defaultInclude };
  transferItems.forEach((item) => {
    next[item.key] = value;
  });
  return next;
}

function formatFileSize(file: File | null) {
  if (!file) return "";
  if (file.size >= 1024 * 1024) return `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (file.size >= 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${file.size} B`;
}

type IncludePickerProps = {
  include: BackupInclude;
  onChange: (include: BackupInclude) => void;
};

function IncludePicker({ include, onChange }: IncludePickerProps) {
  const count = selectedCount(include);
  const toggle = (key: keyof BackupInclude, value: boolean) => {
    onChange({ ...include, [key]: value });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-stone-500">
        <span>已选择 {count} 类数据</span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" className="h-8 rounded-lg border-stone-200 bg-white px-3 text-stone-700" onClick={() => onChange(setAllInclude(true))}>
            全选
          </Button>
          <Button type="button" variant="outline" className="h-8 rounded-lg border-stone-200 bg-white px-3 text-stone-700" onClick={() => onChange(setAllInclude(false))}>
            清空
          </Button>
        </div>
      </div>
      <div className="grid max-h-[48vh] gap-3 overflow-y-auto pr-1 sm:grid-cols-2">
        {transferItems.map((item) => (
          <label key={item.key} className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
            <Checkbox checked={Boolean(include[item.key])} onCheckedChange={(checked) => toggle(item.key, Boolean(checked))} />
            <span>
              <span className="block font-medium text-stone-800">{item.label}</span>
              <span className="mt-1 block text-xs text-stone-500">{item.note}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function DataTransferCard() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [exportInclude, setExportInclude] = useState<BackupInclude>(defaultInclude);
  const [importInclude, setImportInclude] = useState<BackupInclude>(defaultInclude);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const exportCount = useMemo(() => selectedCount(exportInclude), [exportInclude]);
  const importCount = useMemo(() => selectedCount(importInclude), [importInclude]);

  const openImportFilePicker = () => {
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.click();
    }
  };

  const handleFileSelected = (file: File | null) => {
    setSelectedFile(file);
    if (file) {
      setImportInclude(defaultInclude);
      setImportOpen(true);
    }
  };

  const handleExport = async () => {
    if (exportCount === 0) {
      toast.error("请至少选择一类要导出的数据");
      return;
    }
    setIsExporting(true);
    try {
      const authKey = await getStoredAuthKey();
      if (!authKey) {
        toast.error("当前登录已失效，请重新登录后再导出");
        return;
      }
      const response = await fetch(`${webConfig.apiUrl.replace(/\/$/, "")}/api/data/export`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ include: exportInclude }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { detail?: { error?: string }; error?: string } | null;
        throw new Error(data?.detail?.error || data?.error || "导出失败");
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = getFilenameFromContentDisposition(response.headers.get("Content-Disposition")) || "chatgpt2api-data.tar.gz";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setExportOpen(false);
      toast.success("数据导出已开始下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出失败");
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async () => {
    if (importCount === 0) {
      toast.error("请至少选择一类要导入的数据");
      return;
    }
    if (!selectedFile) {
      toast.error("请先选择导入文件");
      return;
    }
    setIsImporting(true);
    try {
      const data = await importDataPackage(selectedFile, importInclude);
      const imported = data.result.imported?.join("、") || "无";
      toast.success(`导入完成：${imported}`);
      if (importInclude.config || importInclude.auth_keys_snapshot) {
        toast.info("如果导入了系统配置或用户密钥，建议刷新页面后继续操作");
      }
      setImportOpen(false);
      setSelectedFile(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-5 p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-950 text-white">
                <DatabaseBackup className="size-4" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-stone-950">配置数据导入导出</h2>
                <p className="mt-1 text-sm text-stone-500">手动迁移当前程序数据，导入和导出前再选择具体范围。</p>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <button
              type="button"
              className="flex min-h-28 items-center gap-4 rounded-xl border border-dashed border-stone-300 bg-stone-50 px-5 py-4 text-left transition hover:border-stone-400 hover:bg-white"
              onClick={openImportFilePicker}
              disabled={isImporting}
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-stone-700 shadow-sm">
                <FolderOpen className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-stone-900">导入数据</span>
                <span className="mt-1 block text-sm text-stone-500">选择备份文件后，再确认要导入的数据类别。</span>
              </span>
            </button>

            <button
              type="button"
              className="flex min-h-28 items-center gap-4 rounded-xl border border-stone-200 bg-stone-50 px-5 py-4 text-left transition hover:border-stone-300 hover:bg-white"
              onClick={() => setExportOpen(true)}
              disabled={isExporting}
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white text-stone-700 shadow-sm">
                <FileArchive className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-stone-900">导出备份</span>
                <span className="mt-1 block text-sm text-stone-500">先选择导出范围，再下载一个可迁移的数据包。</span>
              </span>
            </button>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".tar.gz,.gz,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(event) => handleFileSelected(event.target.files?.[0] ?? null)}
          />
        </CardContent>
      </Card>

      <Dialog open={importOpen} onOpenChange={(open) => { if (!isImporting) setImportOpen(open); }}>
        <DialogContent showCloseButton={false} className="max-h-[88vh] max-w-3xl overflow-hidden rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>选择要导入的数据</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              {selectedFile ? `文件：${selectedFile.name} · ${formatFileSize(selectedFile)}` : "请选择要导入的数据包。"}
            </DialogDescription>
          </DialogHeader>
          <IncludePicker include={importInclude} onChange={setImportInclude} />
          <DialogFooter className="pt-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setImportOpen(false)} disabled={isImporting}>
              取消
            </Button>
            <Button className="rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleImport()} disabled={isImporting || importCount === 0 || !selectedFile}>
              {isImporting ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
              确认导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={exportOpen} onOpenChange={(open) => { if (!isExporting) setExportOpen(open); }}>
        <DialogContent showCloseButton={false} className="max-h-[88vh] max-w-3xl overflow-hidden rounded-2xl p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>选择要导出的数据</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              只导出勾选的数据类别；包含生成图片时，备份包会明显变大。
            </DialogDescription>
          </DialogHeader>
          <IncludePicker include={exportInclude} onChange={setExportInclude} />
          <DialogFooter className="pt-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setExportOpen(false)} disabled={isExporting}>
              取消
            </Button>
            <Button className="rounded-xl bg-stone-950 text-white hover:bg-stone-800" onClick={() => void handleExport()} disabled={isExporting || exportCount === 0}>
              {isExporting ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              确认导出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
