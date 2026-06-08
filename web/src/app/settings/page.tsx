"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ImageManagerContent } from "@/app/image-manager/image-manager-content";
import { LogsContent } from "@/app/logs/logs-content";
import { cn } from "@/lib/utils";
import { AdminPasswordCard } from "./components/admin-password-card";
import { BackupSettingsCard } from "./components/backup-settings-card";
import { ConfigCard } from "./components/config-card";
import { DataTransferCard } from "./components/data-transfer-card";
import { ImageProvidersCard } from "./components/image-providers-card";
import { SettingsAdminFrame } from "./components/settings-admin-frame";
import type { SettingsSectionId } from "./components/settings-section-shell";
import { UserKeysCard } from "./components/user-keys-card";
import { useSettingsStore } from "./store";

const validSectionIds = new Set<SettingsSectionId>(["base", "images", "logs"]);

function normalizeSectionId(value: string | null | undefined): SettingsSectionId {
  const candidate = String(value || "").replace(/^#/, "").trim();
  return validSectionIds.has(candidate as SettingsSectionId) ? (candidate as SettingsSectionId) : "base";
}

function sectionUrl(sectionId: SettingsSectionId) {
  return sectionId === "base" ? "/settings" : `/settings#${sectionId}`;
}

function paneClass(active: boolean) {
  return cn("settings-section-pane", active ? "block" : "hidden");
}

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const backupState = useSettingsStore((state) => state.backupState);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (!backupState?.running) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadBackups(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [backupState?.running, loadBackups]);

  return null;
}

function SettingsPageContent() {
  const [activeSectionId, setActiveSectionId] = useState<SettingsSectionId>(() =>
    typeof window === "undefined" ? "base" : normalizeSectionId(window.location.hash),
  );
  const [visitedSectionIds, setVisitedSectionIds] = useState<Set<SettingsSectionId>>(() => new Set(["base"]));

  useEffect(() => {
    const syncFromLocation = () => {
      const normalized = normalizeSectionId(window.location.hash);
      setActiveSectionId(normalized);
      if (normalized === "base" && window.location.hash && window.location.hash !== "#base") {
        window.history.replaceState(null, "", "/settings");
      }
    };
    syncFromLocation();
    window.addEventListener("hashchange", syncFromLocation);
    return () => window.removeEventListener("hashchange", syncFromLocation);
  }, []);

  useEffect(() => {
    setVisitedSectionIds((current) => {
      if (current.has(activeSectionId)) {
        return current;
      }
      const next = new Set(current);
      next.add(activeSectionId);
      return next;
    });
  }, [activeSectionId]);

  const handleSectionChange = useCallback((sectionId: SettingsSectionId) => {
    setActiveSectionId(sectionId);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", sectionUrl(sectionId));
    }
  }, []);

  const hasVisited = useMemo(
    () => ({
      base: visitedSectionIds.has("base"),
      images: visitedSectionIds.has("images"),
      logs: visitedSectionIds.has("logs"),
    }),
    [visitedSectionIds],
  );

  return (
    <SettingsAdminFrame activeSectionId={activeSectionId} onSectionChange={handleSectionChange}>
      <SettingsDataController />
      {hasVisited.base ? (
        <div className={paneClass(activeSectionId === "base")}>
          <section className="space-y-4">
            <ImageProvidersCard />
            <ConfigCard />
            <AdminPasswordCard />
            <DataTransferCard />
            <BackupSettingsCard />
            <UserKeysCard />
          </section>
        </div>
      ) : null}
      {hasVisited.images ? (
        <div className={paneClass(activeSectionId === "images")}>
          <ImageManagerContent />
        </div>
      ) : null}
      {hasVisited.logs ? (
        <div className={paneClass(activeSectionId === "logs")}>
          <LogsContent />
        </div>
      ) : null}
    </SettingsAdminFrame>
  );
}

export default function SettingsPage() {
  return <SettingsPageContent />;
}
