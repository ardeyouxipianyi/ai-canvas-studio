"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountsPageContent } from "@/app/accounts/accounts-page-content";
import { ImageManagerContent } from "@/app/image-manager/image-manager-content";
import { LogsContent } from "@/app/logs/logs-content";
import { AdminPasswordCard } from "./components/admin-password-card";
import { BackupSettingsCard } from "./components/backup-settings-card";
import { ConfigCard } from "./components/config-card";
import { CPAPoolDialog } from "./components/cpa-pool-dialog";
import { CPAPoolsCard } from "./components/cpa-pools-card";
import { DataTransferCard } from "./components/data-transfer-card";
import { ImportBrowserDialog } from "./components/import-browser-dialog";
import { SettingsAdminFrame } from "./components/settings-admin-frame";
import { SettingsHeader } from "./components/settings-header";
import type { SettingsSectionId } from "./components/settings-section-shell";
import { Sub2APIConnections } from "./components/sub2api-connections";
import { UserKeysCard } from "./components/user-keys-card";
import { useSettingsStore } from "./store";

const validSectionIds = new Set<SettingsSectionId>(["base", "accounts", "images", "logs"]);

function normalizeSectionId(value: string | null | undefined): SettingsSectionId {
  const candidate = String(value || "").replace(/^#/, "").trim();
  return validSectionIds.has(candidate as SettingsSectionId) ? (candidate as SettingsSectionId) : "base";
}

function sectionUrl(sectionId: SettingsSectionId) {
  return sectionId === "base" ? "/settings" : `/settings#${sectionId}`;
}

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadPools = useSettingsStore((state) => state.loadPools);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const pools = useSettingsStore((state) => state.pools);
  const backupState = useSettingsStore((state) => state.backupState);

  useEffect(() => {
    if (didLoadRef.current) {
      return;
    }
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const hasRunningJobs = pools.some((pool) => {
      const status = pool.import_job?.status;
      return status === "pending" || status === "running";
    });
    if (!hasRunningJobs) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadPools(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadPools, pools]);

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
      setActiveSectionId(normalizeSectionId(window.location.hash));
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
      accounts: visitedSectionIds.has("accounts"),
      images: visitedSectionIds.has("images"),
      logs: visitedSectionIds.has("logs"),
    }),
    [visitedSectionIds],
  );

  return (
    <SettingsAdminFrame activeSectionId={activeSectionId} onSectionChange={handleSectionChange}>
      <SettingsDataController />
      {hasVisited.base ? (
        <div className={activeSectionId === "base" ? "block" : "hidden"}>
          <SettingsHeader />
          <section className="space-y-4">
            <ConfigCard />
            <AdminPasswordCard />
            <DataTransferCard />
            <BackupSettingsCard />
            <UserKeysCard />
            <CPAPoolsCard />
            <Sub2APIConnections />
          </section>
          <CPAPoolDialog />
          <ImportBrowserDialog />
        </div>
      ) : null}
      {hasVisited.accounts ? (
        <div className={activeSectionId === "accounts" ? "block" : "hidden"}>
          <AccountsPageContent />
        </div>
      ) : null}
      {hasVisited.images ? (
        <div className={activeSectionId === "images" ? "block" : "hidden"}>
          <ImageManagerContent />
        </div>
      ) : null}
      {hasVisited.logs ? (
        <div className={activeSectionId === "logs" ? "block" : "hidden"}>
          <LogsContent />
        </div>
      ) : null}
    </SettingsAdminFrame>
  );
}

export default function SettingsPage() {
  return <SettingsPageContent />;
}
