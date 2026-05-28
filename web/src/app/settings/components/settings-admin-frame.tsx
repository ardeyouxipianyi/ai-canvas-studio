"use client";

import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";

import { SettingsSectionShell, type SettingsSectionId } from "./settings-section-shell";

export function SettingsAdminFrame({
  activeSectionId,
  children,
  onSectionChange,
}: {
  activeSectionId: SettingsSectionId;
  children: React.ReactNode;
  onSectionChange: (sectionId: SettingsSectionId) => void;
}) {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <SettingsSectionShell activeSectionId={activeSectionId} onSectionChange={onSectionChange}>
      {children}
    </SettingsSectionShell>
  );
}
