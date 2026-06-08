"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchSetupStatus, initializeAdminPassword, login } from "@/lib/api";
import { getValidatedAuthSession } from "@/lib/auth-session";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

type LoginMode = "checking" | "login" | "setup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("checking");
  const [authKey, setAuthKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const setup = await fetchSetupStatus();
        if (!active) {
          return;
        }
        if (setup.setup_required) {
          setMode("setup");
          return;
        }

        const storedSession = await getValidatedAuthSession();
        if (!active) {
          return;
        }
        if (storedSession) {
          router.replace(getDefaultRouteForRole(storedSession.role));
          return;
        }
      } catch {
        if (!active) {
          return;
        }
      }
      setMode("login");
    };

    void load();
    return () => {
      active = false;
    };
  }, [router]);

  const handleLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      toast.error("请输入密码");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await login(normalizedAuthKey);
      await setStoredAuthSession({
        key: normalizedAuthKey,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetup = async () => {
    const normalizedNewKey = newKey.trim();
    const normalizedConfirmKey = confirmKey.trim();
    if (!normalizedNewKey) {
      toast.error("请输入管理员密码");
      return;
    }
    if (normalizedNewKey.length < 6) {
      toast.error("管理员密码至少需要 6 个字符");
      return;
    }
    if (normalizedNewKey !== normalizedConfirmKey) {
      toast.error("两次输入的密码不一致");
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await initializeAdminPassword(normalizedNewKey);
      await setStoredAuthSession({
        key: normalizedNewKey,
        role: data.role,
        subjectId: data.subject_id,
        name: data.name,
      });
      router.replace(getDefaultRouteForRole(data.role));
    } catch (error) {
      const message = error instanceof Error ? error.message : "设置失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (mode === "checking") {
    return (
      <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  const isSetup = mode === "setup";

  return (
    <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
      <Card className="w-full max-w-[505px] rounded-[30px] border-white/80 bg-white/95 shadow-[0_28px_90px_rgba(28,25,23,0.10)]">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-[18px] bg-stone-950 text-white shadow-sm">
              {isSetup ? <ShieldCheck className="size-5" /> : <LockKeyhole className="size-5" />}
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">
                {isSetup ? "首次部署设置" : "欢迎回来"}
              </h1>
              <p className="text-sm leading-6 text-stone-500">
                {isSetup
                  ? "请先设置管理员密码。设置完成后，后续网页登录都使用这个密码。"
                  : "输入管理员密码或用户密钥后继续使用。"}
              </p>
            </div>
          </div>

          {isSetup ? (
            <div className="space-y-4">
              <div className="space-y-3">
                <label htmlFor="new-admin-key" className="block text-sm font-medium text-stone-700">
                  管理员密码
                </label>
                <Input
                  id="new-admin-key"
                  type="password"
                  autoComplete="new-password"
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder="至少 6 个字符"
                  className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                />
              </div>
              <div className="space-y-3">
                <label htmlFor="confirm-admin-key" className="block text-sm font-medium text-stone-700">
                  确认密码
                </label>
                <Input
                  id="confirm-admin-key"
                  type="password"
                  autoComplete="new-password"
                  value={confirmKey}
                  onChange={(event) => setConfirmKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      void handleSetup();
                    }
                  }}
                  placeholder="再次输入管理员密码"
                  className="h-13 rounded-2xl border-stone-200 bg-white px-4"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label htmlFor="auth-key" className="block text-sm font-medium text-stone-700">
                密码 / 用户密钥
              </label>
              <Input
                id="auth-key"
                type="password"
                autoComplete="current-password"
                value={authKey}
                onChange={(event) => setAuthKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleLogin();
                  }
                }}
                placeholder="请输入密码或用户密钥"
                className="h-13 rounded-2xl border-stone-200 bg-white px-4"
              />
            </div>
          )}

          <Button
            className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
            onClick={() => void (isSetup ? handleSetup() : handleLogin())}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {isSetup ? "保存并进入" : "登录"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
