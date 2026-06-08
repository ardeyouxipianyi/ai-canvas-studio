"use client";

import { KeyRound, LoaderCircle, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { updateAdminPassword } from "@/lib/api";
import { setStoredAuthSession } from "@/store/auth";

import { useSettingsStore } from "../store";

export function AdminPasswordCard() {
  const config = useSettingsStore((state) => state.config);
  const [currentKey, setCurrentKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const editable = config?.admin_auth_key_editable !== false;

  const handleSave = async () => {
    const normalizedCurrent = currentKey.trim();
    const normalizedNew = newKey.trim();
    const normalizedConfirm = confirmKey.trim();
    if (!normalizedCurrent) {
      toast.error("请输入当前管理员密码");
      return;
    }
    if (normalizedNew.length < 6) {
      toast.error("新管理员密码至少需要 6 个字符");
      return;
    }
    if (normalizedNew !== normalizedConfirm) {
      toast.error("两次输入的新密码不一致");
      return;
    }

    setIsSaving(true);
    try {
      const data = await updateAdminPassword(normalizedCurrent, normalizedNew);
      await setStoredAuthSession({
        key: normalizedNew,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      setCurrentKey("");
      setNewKey("");
      setConfirmKey("");
      toast.success("管理员密码已修改");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "修改管理员密码失败");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-4 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-stone-950 text-white">
            <KeyRound className="size-4" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-stone-950">管理员密码</h2>
            <p className="mt-1 text-sm text-stone-500">修改后，网页登录的管理员密码会一起变更。</p>
          </div>
        </div>

        {!editable ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
            当前管理员密码由启动环境固定，网页里不能直接修改。
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-sm text-stone-700">当前管理员密码</label>
            <Input
              type="password"
              value={currentKey}
              onChange={(event) => setCurrentKey(event.target.value)}
              disabled={!editable || isSaving}
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">新管理员密码</label>
            <Input
              type="password"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              disabled={!editable || isSaving}
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm text-stone-700">再次输入新密码</label>
            <Input
              type="password"
              value={confirmKey}
              onChange={(event) => setConfirmKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleSave();
                }
              }}
              disabled={!editable || isSaving}
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            className="h-10 rounded-xl bg-stone-950 px-5 text-white hover:bg-stone-800"
            onClick={() => void handleSave()}
            disabled={!editable || isSaving}
          >
            {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存新密码
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
