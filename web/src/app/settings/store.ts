"use client";

import { create } from "zustand";
import { toast } from "sonner";

import {
  DEFAULT_REVERSE_PROMPT_INSTRUCTION,
  deleteBackup,
  fetchBackups,
  fetchSettingsConfig,
  runBackupNow,
  testBackupConnection,
  updateSettingsConfig,
  type BackupItem,
  type BackupSettings,
  type BackupState,
  type SettingsConfig,
} from "@/lib/api";

function normalizeConfig(config: SettingsConfig): SettingsConfig {
  const backup = typeof config.backup === "object" && config.backup
    ? config.backup as BackupSettings
    : {
      enabled: false,
      provider: "cloudflare_r2",
      account_id: "",
      access_key_id: "",
      secret_access_key: "",
      bucket: "",
      prefix: "backups",
      interval_minutes: 360,
      rotation_keep: 10,
      encrypt: false,
      passphrase: "",
      include: {
        config: true,
        register: false,
        cpa: false,
        sub2api: false,
        logs: true,
        image_tasks: true,
        image_providers: true,
        image_conversations: true,
        image_canvas: true,
        accounts_snapshot: false,
        auth_keys_snapshot: true,
        images: false,
      },
    };
  return {
    ...config,
    refresh_account_interval_minute: Number(config.refresh_account_interval_minute || 5),
    account_refresh_concurrency: Number(config.account_refresh_concurrency || 10),
    image_retention_days: Number(config.image_retention_days || 30),
    image_poll_timeout_secs: Number(config.image_poll_timeout_secs || 120),
    image_unaccepted_task_timeout_secs: Number(config.image_unaccepted_task_timeout_secs || 20),
    image_stalled_result_timeout_secs: Number(config.image_stalled_result_timeout_secs || 60),
    image_account_concurrency: Number(config.image_account_concurrency || 3),
    image_account_recheck_interval_secs: Number(config.image_account_recheck_interval_secs || 300),
    image_pool_failover_enabled: Boolean(config.image_pool_failover_enabled ?? true),
    image_pool_max_attempts: Number(config.image_pool_max_attempts || 3),
    image_account_failure_cooldown_secs: Number(config.image_account_failure_cooldown_secs || 60),
    image_empty_result_retry_enabled: Boolean(config.image_empty_result_retry_enabled ?? true),
    auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
    auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
    admin_auth_key_editable: Boolean(config.admin_auth_key_editable ?? true),
    log_levels: Array.isArray(config.log_levels) ? config.log_levels : [],
    proxy: typeof config.proxy === "string" ? config.proxy : "",
    base_url: typeof config.base_url === "string" ? config.base_url : "",
    global_system_prompt: String(config.global_system_prompt || ""),
    reverse_prompt_instruction: String(config.reverse_prompt_instruction || DEFAULT_REVERSE_PROMPT_INSTRUCTION),
    sensitive_words: Array.isArray(config.sensitive_words) ? config.sensitive_words : [],
    ai_review: {
      enabled: Boolean(config.ai_review?.enabled),
      base_url: String(config.ai_review?.base_url || ""),
      api_key: String(config.ai_review?.api_key || ""),
      model: String(config.ai_review?.model || ""),
      prompt: String(config.ai_review?.prompt || ""),
    },
    backup: {
      ...backup,
      enabled: Boolean(backup.enabled),
      account_id: String(backup.account_id || ""),
      access_key_id: String(backup.access_key_id || ""),
      secret_access_key: String(backup.secret_access_key || ""),
      bucket: String(backup.bucket || ""),
      prefix: String(backup.prefix || "backups"),
      interval_minutes: Number(backup.interval_minutes || 360),
      rotation_keep: Number(backup.rotation_keep ?? 10),
      encrypt: Boolean(backup.encrypt),
      passphrase: String(backup.passphrase || ""),
      include: {
        config: Boolean(backup.include?.config ?? true),
        register: false,
        cpa: false,
        sub2api: false,
        logs: Boolean(backup.include?.logs ?? true),
        image_tasks: Boolean(backup.include?.image_tasks ?? true),
        image_providers: Boolean(backup.include?.image_providers ?? true),
        image_conversations: Boolean(backup.include?.image_conversations ?? true),
        image_canvas: Boolean(backup.include?.image_canvas ?? true),
        accounts_snapshot: false,
        auth_keys_snapshot: Boolean(backup.include?.auth_keys_snapshot ?? true),
        images: Boolean(backup.include?.images ?? false),
      },
    },
  };
}

type SettingsStore = {
  config: SettingsConfig | null;
  isLoadingConfig: boolean;
  isSavingConfig: boolean;
  backups: BackupItem[];
  backupState: BackupState | null;
  isLoadingBackups: boolean;
  isRunningBackup: boolean;
  deletingBackupKey: string | null;
  isTestingBackup: boolean;

  initialize: () => Promise<void>;
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<boolean>;
  loadBackups: (silent?: boolean) => Promise<void>;
  runBackup: () => Promise<void>;
  removeBackup: (key: string) => Promise<void>;
  testBackup: () => Promise<void>;
  setRefreshAccountIntervalMinute: (value: string) => void;
  setAccountRefreshConcurrency: (value: string) => void;
  setImageRetentionDays: (value: string) => void;
  setImagePollTimeoutSecs: (value: string) => void;
  setImageUnacceptedTaskTimeoutSecs: (value: string) => void;
  setImageStalledResultTimeoutSecs: (value: string) => void;
  setImageAccountConcurrency: (value: string) => void;
  setImagePoolFailoverEnabled: (value: boolean) => void;
  setImagePoolMaxAttempts: (value: string) => void;
  setImageAccountFailureCooldownSecs: (value: string) => void;
  setImageEmptyResultRetryEnabled: (value: boolean) => void;
  setAutoRemoveInvalidAccounts: (value: boolean) => void;
  setAutoRemoveRateLimitedAccounts: (value: boolean) => void;
  setLogLevel: (level: string, enabled: boolean) => void;
  setProxy: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setGlobalSystemPrompt: (value: string) => void;
  setReversePromptInstruction: (value: string) => void;
  setSensitiveWordsText: (value: string) => void;
  setAIReviewField: (key: "enabled" | "base_url" | "api_key" | "model" | "prompt", value: string | boolean) => void;
  setBackupField: (key: keyof BackupSettings, value: string | boolean) => void;
  setBackupInclude: (key: keyof BackupSettings["include"], value: boolean) => void;

};

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  config: null,
  isLoadingConfig: true,
  isSavingConfig: false,
  backups: [],
  backupState: null,
  isLoadingBackups: true,
  isRunningBackup: false,
  deletingBackupKey: null,
  isTestingBackup: false,

  initialize: async () => {
    await get().loadConfig();
    const backup = get().config?.backup;
    const isConfigured = Boolean(
      String(backup?.account_id || "").trim()
      && String(backup?.access_key_id || "").trim()
      && String(backup?.secret_access_key || "").trim()
      && String(backup?.bucket || "").trim(),
    );
    if (isConfigured) {
      await get().loadBackups();
    } else {
      set({ backups: [], isLoadingBackups: false });
    }
  },

  loadConfig: async () => {
    set({ isLoadingConfig: true });
    try {
      const data = await fetchSettingsConfig();
      const normalized = normalizeConfig(data.config);
      set({
        config: normalized,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载系统配置失败");
    } finally {
      set({ isLoadingConfig: false });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) {
      return false;
    }

    set({ isSavingConfig: true });
    try {
      const data = await updateSettingsConfig({
        ...config,
        refresh_account_interval_minute: Math.max(1, Number(config.refresh_account_interval_minute) || 1),
        account_refresh_concurrency: Math.min(100, Math.max(1, Number(config.account_refresh_concurrency) || 10)),
        image_retention_days: Math.max(1, Number(config.image_retention_days) || 30),
        image_poll_timeout_secs: Math.max(1, Number(config.image_poll_timeout_secs) || 120),
        image_unaccepted_task_timeout_secs: Math.max(1, Number(config.image_unaccepted_task_timeout_secs) || 20),
        image_stalled_result_timeout_secs: Math.max(1, Number(config.image_stalled_result_timeout_secs) || 60),
        image_account_concurrency: Math.max(1, Number(config.image_account_concurrency) || 3),
        image_account_recheck_interval_secs: Math.max(0, Number(config.image_account_recheck_interval_secs) || 0),
        image_pool_failover_enabled: Boolean(config.image_pool_failover_enabled ?? true),
        image_pool_max_attempts: Math.max(1, Number(config.image_pool_max_attempts) || 3),
        image_account_failure_cooldown_secs: Math.max(0, Number(config.image_account_failure_cooldown_secs) || 0),
        image_empty_result_retry_enabled: Boolean(config.image_empty_result_retry_enabled),
        auto_remove_invalid_accounts: Boolean(config.auto_remove_invalid_accounts),
        auto_remove_rate_limited_accounts: Boolean(config.auto_remove_rate_limited_accounts),
        proxy: config.proxy.trim(),
        base_url: String(config.base_url || "").trim(),
        global_system_prompt: String(config.global_system_prompt || "").trim(),
        reverse_prompt_instruction: String(config.reverse_prompt_instruction || "").trim(),
        sensitive_words: (config.sensitive_words || []).map((item) => String(item).trim()).filter(Boolean),
        ai_review: {
          enabled: Boolean(config.ai_review?.enabled),
          base_url: String(config.ai_review?.base_url || "").trim(),
          api_key: String(config.ai_review?.api_key || "").trim(),
          model: String(config.ai_review?.model || "").trim(),
          prompt: String(config.ai_review?.prompt || "").trim(),
        },
        backup: {
          ...(config.backup as BackupSettings),
          account_id: String(config.backup?.account_id || "").trim(),
          access_key_id: String(config.backup?.access_key_id || "").trim(),
          secret_access_key: String(config.backup?.secret_access_key || "").trim(),
          bucket: String(config.backup?.bucket || "").trim(),
          prefix: String(config.backup?.prefix || "backups").trim(),
          interval_minutes: Math.max(1, Number(config.backup?.interval_minutes) || 360),
          rotation_keep: Math.max(0, Number(config.backup?.rotation_keep) || 0),
          passphrase: String(config.backup?.passphrase || "").trim(),
        },
      });
      set({
        config: normalizeConfig(data.config),
      });
      toast.success("配置已保存");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存系统配置失败");
      return false;
    } finally {
      set({ isSavingConfig: false });
    }
  },

  setRefreshAccountIntervalMinute: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          refresh_account_interval_minute: value,
        },
      };
    });
  },

  setAccountRefreshConcurrency: (value) => {
    set((state) => state.config ? { config: { ...state.config, account_refresh_concurrency: value } } : {});
  },

  setImageRetentionDays: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_retention_days: value } } : {});
  },

  setImagePollTimeoutSecs: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_poll_timeout_secs: value } } : {});
  },

  setImageUnacceptedTaskTimeoutSecs: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_unaccepted_task_timeout_secs: value } } : {});
  },

  setImageStalledResultTimeoutSecs: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_stalled_result_timeout_secs: value } } : {});
  },

  setImageAccountConcurrency: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_account_concurrency: value } } : {});
  },

  setImagePoolFailoverEnabled: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_pool_failover_enabled: value } } : {});
  },

  setImagePoolMaxAttempts: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_pool_max_attempts: value } } : {});
  },

  setImageAccountFailureCooldownSecs: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_account_failure_cooldown_secs: value } } : {});
  },

  setImageEmptyResultRetryEnabled: (value) => {
    set((state) => state.config ? { config: { ...state.config, image_empty_result_retry_enabled: value } } : {});
  },

  setAutoRemoveInvalidAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_invalid_accounts: value } } : {});
  },

  setAutoRemoveRateLimitedAccounts: (value) => {
    set((state) => state.config ? { config: { ...state.config, auto_remove_rate_limited_accounts: value } } : {});
  },

  setLogLevel: (level, enabled) => {
    set((state) => {
      if (!state.config) return {};
      const levels = new Set(state.config.log_levels || []);
      if (enabled) levels.add(level);
      else levels.delete(level);
      return { config: { ...state.config, log_levels: Array.from(levels) } };
    });
  },

  setProxy: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          proxy: value,
        },
      };
    });
  },

  setBaseUrl: (value) => {
    set((state) => {
      if (!state.config) {
        return {};
      }
      return {
        config: {
          ...state.config,
          base_url: value,
        },
      };
    });
  },

  setGlobalSystemPrompt: (value) => {
    set((state) => state.config ? { config: { ...state.config, global_system_prompt: value } } : {});
  },

  setReversePromptInstruction: (value) => {
    set((state) => state.config ? { config: { ...state.config, reverse_prompt_instruction: value } } : {});
  },

  setSensitiveWordsText: (value) => {
    set((state) => state.config ? { config: { ...state.config, sensitive_words: value.split("\n") } } : {});
  },

  setAIReviewField: (key, value) => {
    set((state) => state.config ? { config: { ...state.config, ai_review: { ...(state.config.ai_review || {}), [key]: value } } } : {});
  },

  setBackupField: (key, value) => {
    set((state) => {
      if (!state.config?.backup) {
        return {};
      }
      return {
        config: {
          ...state.config,
          backup: {
            ...state.config.backup,
            [key]: value,
          },
        },
      };
    });
  },

  setBackupInclude: (key, value) => {
    set((state) => {
      if (!state.config?.backup) {
        return {};
      }
      return {
        config: {
          ...state.config,
          backup: {
            ...state.config.backup,
            include: {
              ...state.config.backup.include,
              [key]: value,
            },
          },
        },
      };
    });
  },

  loadBackups: async (silent = false) => {
    if (!silent) {
      set({ isLoadingBackups: true });
    }
    try {
      const data = await fetchBackups();
      set({
        backups: data.items,
        backupState: data.state,
      });
    } catch (error) {
      if (!silent) {
        toast.error(error instanceof Error ? error.message : "加载备份列表失败");
      }
    } finally {
      if (!silent) {
        set({ isLoadingBackups: false });
      }
    }
  },

  runBackup: async () => {
    set({ isRunningBackup: true });
    try {
      const saved = await get().saveConfig();
      if (!saved) {
        return;
      }
      const data = await runBackupNow();
      toast.success(`备份已完成：${data.result.key}`);
      await get().loadBackups(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "执行备份失败");
    } finally {
      set({ isRunningBackup: false });
    }
  },

  removeBackup: async (key) => {
    set({ deletingBackupKey: key });
    try {
      await deleteBackup(key);
      toast.success("备份已删除");
      await get().loadBackups(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除备份失败");
    } finally {
      set({ deletingBackupKey: null });
    }
  },

  testBackup: async () => {
    set({ isTestingBackup: true });
    try {
      const saved = await get().saveConfig();
      if (!saved) {
        return;
      }
      const data = await testBackupConnection();
      toast.success(`R2 连接正常（HTTP ${data.result.status}）`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试备份连接失败");
    } finally {
      set({ isTestingBackup: false });
    }
  },

}));
