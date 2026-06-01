from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Condition, Lock, Thread
from typing import Any
from datetime import datetime, timezone
import time
import uuid

from services.config import config
from services.log_service import (
    LOG_TYPE_ACCOUNT,
    log_service,
)
from services.storage.base import StorageBackend
from utils.helper import anonymize_token


REFRESH_SAVE_BATCH_SIZE = 50


class AccountService:
    """账号池服务，使用 token -> account 的 dict 保存账号。"""

    def __init__(self, storage_backend: StorageBackend):
        self.storage = storage_backend
        self._lock = Lock()
        self._image_slot_condition = Condition(self._lock)
        self._index = 0
        self._accounts = self._load_accounts()
        self._image_inflight: dict[str, int] = {}
        self._image_cooldowns: dict[str, float] = {}
        self._refresh_jobs: dict[str, dict[str, Any]] = {}
        self._refresh_jobs_lock = Lock()

    def _load_accounts(self) -> dict[str, dict]:
        accounts = self.storage.load_accounts()
        return {
            normalized["access_token"]: normalized
            for item in accounts
            if (normalized := self._normalize_account(item)) is not None
        }

    def _save_accounts(self) -> None:
        self.storage.save_accounts(list(self._accounts.values()))

    @staticmethod
    def _is_image_account_available(account: dict) -> bool:
        if not isinstance(account, dict):
            return False
        if account.get("status") in {"禁用", "限流", "异常"}:
            return False
        if bool(account.get("image_quota_unknown")):
            return True
        return int(account.get("quota") or 0) > 0

    @classmethod
    def _account_matches_plan_type(cls, account: dict, plan_type: str | None = None) -> bool:
        if not plan_type:
            return True
        normalized_plan = cls._normalize_account_type(plan_type)
        normalized_account = cls._normalize_account_type(account.get("type"))
        if not normalized_plan or not normalized_account:
            return False
        return normalized_plan.lower() == normalized_account.lower()

    @classmethod
    def _account_matches_any_plan_type(cls, account: dict, plan_types: set[str] | tuple[str, ...] | None = None) -> bool:
        if not plan_types:
            return True
        normalized_account = cls._normalize_account_type(account.get("type"))
        normalized_plans = {
            normalized
            for plan_type in plan_types
            if (normalized := cls._normalize_account_type(plan_type))
        }
        return bool(normalized_account and normalized_account in normalized_plans)

    @staticmethod
    def _normalize_source_type(value: object) -> str:
        return str(value or "web").strip().lower() or "web"

    @classmethod
    def _account_matches_source_type(cls, account: dict, source_type: str | None = None) -> bool:
        if not source_type:
            return True
        return cls._normalize_source_type(account.get("source_type")) == cls._normalize_source_type(source_type)

    @staticmethod
    def _normalize_account_type(value: object) -> str:
        raw = str(value or "").strip()
        if not raw:
            return "free"
        key = raw.lower().replace("_", "").replace("-", "").replace(" ", "")
        aliases = {
            "free": "free",
            "plus": "Plus",
            "pro": "Pro",
            "prolite": "ProLite",
            "team": "Team",
            "business": "Team",
            "enterprise": "Enterprise",
        }
        return aliases.get(key, raw)

    def _search_account_type(self, value: object) -> str | None:
        type_keys = {
            "account_plan_type",
            "account_plan",
            "account_type",
            "billing_plan_type",
            "chatgpt_plan_type",
            "plan",
            "plan_type",
            "subscription_plan",
            "subscription_type",
        }
        if isinstance(value, dict):
            for key, nested in value.items():
                normalized_key = str(key or "").strip().lower()
                if normalized_key in type_keys and not isinstance(nested, (dict, list)):
                    candidate = self._normalize_account_type(nested)
                    if candidate:
                        return candidate
                found = self._search_account_type(nested)
                if found:
                    return found
        elif isinstance(value, list):
            for nested in value:
                found = self._search_account_type(nested)
                if found:
                    return found
        return None

    def _normalize_account(self, item: dict) -> dict | None:
        if not isinstance(item, dict):
            return None
        access_token = item.get("access_token") or item.get("accessToken") or ""
        if not access_token:
            return None
        normalized = dict(item)
        normalized.pop("accessToken", None)
        normalized["access_token"] = access_token
        if str(normalized.get("type") or "").strip().lower() == "codex":
            normalized["export_type"] = "codex"
            normalized.pop("type", None)
        if str(normalized.get("export_type") or "").strip().lower() == "codex":
            normalized["source_type"] = "codex"
        normalized["type"] = self._normalize_account_type(
            normalized.get("type")
            or normalized.get("plan_type")
            or self._search_account_type(item)
        )
        normalized["status"] = normalized.get("status") or "正常"
        normalized["quota"] = max(0, int(normalized.get("quota") if normalized.get("quota") is not None else 0))
        normalized["image_quota_unknown"] = bool(normalized.get("image_quota_unknown"))
        normalized["email"] = normalized.get("email") or None
        normalized["user_id"] = normalized.get("user_id") or None
        normalized["source_type"] = self._normalize_source_type(normalized.get("source_type"))
        limits_progress = normalized.get("limits_progress")
        normalized["limits_progress"] = limits_progress if isinstance(limits_progress, list) else []
        normalized["default_model_slug"] = normalized.get("default_model_slug") or None
        normalized["restore_at"] = normalized.get("restore_at") or None
        normalized["success"] = int(normalized.get("success") or 0)
        normalized["fail"] = int(normalized.get("fail") or 0)
        normalized["last_used_at"] = normalized.get("last_used_at")
        normalized["last_refreshed_at"] = normalized.get("last_refreshed_at") or None
        normalized["last_failed_at"] = normalized.get("last_failed_at") or None
        normalized["last_failure_reason"] = str(normalized.get("last_failure_reason") or "").strip()
        normalized["last_selected_at"] = normalized.get("last_selected_at") or None
        return normalized

    @staticmethod
    def _parse_time(value: object) -> float:
        text = str(value or "").strip()
        if not text:
            return 0.0
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(text[:26], fmt).timestamp()
            except ValueError:
                continue
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0

    def _image_account_score(self, account: dict, token: str, *, now: float | None = None) -> float:
        now = time.time() if now is None else now
        success = max(0, int(account.get("success") or 0))
        fail = max(0, int(account.get("fail") or 0))
        quota = max(0, int(account.get("quota") or 0))
        inflight = max(0, int(self._image_inflight.get(token, 0)))
        total = success + fail
        success_rate = (success + 1) / (total + 2)
        score = success_rate * 100.0
        score += min(quota, 20) * 2.0
        if bool(account.get("image_quota_unknown")):
            score += 8.0
        score -= inflight * 35.0
        score -= min(fail, 20) * 1.5
        last_failed_at = self._parse_time(account.get("last_failed_at"))
        if last_failed_at:
            age = max(0.0, now - last_failed_at)
            penalty_window = max(60, int(config.image_account_failure_cooldown_secs or 60) * 3)
            score -= max(0.0, 30.0 * (1.0 - min(age, penalty_window) / penalty_window))
        last_selected_at = self._parse_time(account.get("last_selected_at") or account.get("last_used_at"))
        if last_selected_at:
            age = max(0.0, now - last_selected_at)
            score += min(age / 60.0, 10.0)
        return score

    def _rank_candidate_tokens(self, tokens: list[str]) -> list[str]:
        now = time.time()
        return sorted(
            tokens,
            key=lambda token: (
                self._image_account_score(self._accounts.get(token, {}), token, now=now),
                str(self._accounts.get(token, {}).get("last_selected_at") or ""),
                token,
            ),
            reverse=True,
        )

    def list_tokens(self) -> list[str]:
        with self._lock:
            return list(self._accounts)

    def replace_accounts(self, accounts: list[dict[str, Any]]) -> int:
        normalized_accounts = {
            normalized["access_token"]: normalized
            for item in accounts
            if (normalized := self._normalize_account(item)) is not None
        }
        with self._image_slot_condition:
            self._accounts = normalized_accounts
            self._index = 0
            self._image_inflight.clear()
            self._image_cooldowns.clear()
            self._save_accounts()
            self._image_slot_condition.notify_all()
        return len(normalized_accounts)

    def _clear_expired_image_cooldowns_locked(self) -> None:
        if not self._image_cooldowns:
            return
        now = time.time()
        expired = [token for token, until in self._image_cooldowns.items() if until <= now]
        for token in expired:
            self._image_cooldowns.pop(token, None)

    def _list_ready_candidate_tokens(
        self,
        excluded_tokens: set[str] | None = None,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> list[str]:
        excluded = set(excluded_tokens or set())
        self._clear_expired_image_cooldowns_locked()
        now = time.time()
        tokens: list[str] = []
        for item in self._accounts.values():
            token = item.get("access_token") or ""
            if not token or token in excluded:
                continue
            if self._image_cooldowns.get(token, 0) > now:
                continue
            if (
                self._is_image_account_available(item)
                and self._account_matches_plan_type(item, plan_type)
                and self._account_matches_any_plan_type(item, plan_types)
                and self._account_matches_source_type(item, source_type)
            ):
                tokens.append(token)
        return tokens

    def _list_available_candidate_tokens(
        self,
        excluded_tokens: set[str] | None = None,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> list[str]:
        max_concurrency = max(1, int(config.image_account_concurrency or 1))
        return [
            token
            for token in self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
            if int(self._image_inflight.get(token, 0)) < max_concurrency
        ]

    def _is_recently_refreshed_image_account(self, account: dict[str, Any] | None) -> bool:
        if not account or not self._is_image_account_available(account):
            return False
        interval = int(config.image_account_recheck_interval_secs or 0)
        if interval <= 0:
            return False
        refreshed_at = self._parse_time(account.get("last_refreshed_at"))
        return bool(refreshed_at) and (time.time() - refreshed_at) <= interval

    def _acquire_next_candidate_token(
        self,
        excluded_tokens: set[str] | None = None,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        with self._image_slot_condition:
            while True:
                if not self._list_ready_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types):
                    label = plan_type or source_type or ""
                    raise RuntimeError(
                        f"no available {label} image quota".replace("  ", " ").strip()
                        if label else "no available image quota"
                    )
                tokens = self._list_available_candidate_tokens(excluded_tokens, plan_type, source_type, plan_types)
                if tokens:
                    ranked_tokens = self._rank_candidate_tokens(tokens)
                    access_token = ranked_tokens[0]
                    self._index += 1
                    self._image_inflight[access_token] = int(self._image_inflight.get(access_token, 0)) + 1
                    current = self._accounts.get(access_token)
                    if current is not None:
                        next_item = dict(current)
                        next_item["last_selected_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                        account = self._normalize_account(next_item)
                        if account is not None:
                            self._accounts[access_token] = account
                            self._save_accounts()
                    return access_token
                self._image_slot_condition.wait(timeout=1.0)

    def release_image_slot(self, access_token: str) -> None:
        if not access_token:
            return
        with self._image_slot_condition:
            current_inflight = int(self._image_inflight.get(access_token, 0))
            if current_inflight <= 1:
                self._image_inflight.pop(access_token, None)
            else:
                self._image_inflight[access_token] = current_inflight - 1
            self._image_slot_condition.notify_all()

    def cooldown_image_token(self, access_token: str, seconds: int | None = None) -> None:
        if not access_token:
            return
        cooldown_secs = config.image_account_failure_cooldown_secs if seconds is None else int(seconds)
        if cooldown_secs <= 0:
            return
        with self._image_slot_condition:
            if access_token in self._accounts:
                self._image_cooldowns[access_token] = time.time() + cooldown_secs
            self._image_slot_condition.notify_all()

    def get_available_access_token(
        self,
        excluded_tokens: set[str] | None = None,
        *,
        plan_type: str | None = None,
        source_type: str | None = None,
        plan_types: set[str] | tuple[str, ...] | None = None,
    ) -> str:
        attempted_tokens: set[str] = set(excluded_tokens or set())
        while True:
            access_token = self._acquire_next_candidate_token(
                excluded_tokens=attempted_tokens,
                plan_type=plan_type,
                source_type=source_type,
                plan_types=plan_types,
            )
            attempted_tokens.add(access_token)
            account = self.get_account(access_token)
            if (
                self._is_recently_refreshed_image_account(account)
                and self._account_matches_plan_type(account or {}, plan_type)
                and self._account_matches_any_plan_type(account or {}, plan_types)
                and self._account_matches_source_type(account or {}, source_type)
            ):
                return access_token
            try:
                account = self.fetch_remote_info(access_token, "get_available_access_token")
            except Exception:
                self.release_image_slot(access_token)
                continue
            if (
                self._is_image_account_available(account or {})
                and self._account_matches_plan_type(account or {}, plan_type)
                and self._account_matches_any_plan_type(account or {}, plan_types)
                and self._account_matches_source_type(account or {}, source_type)
            ):
                return access_token
            self.release_image_slot(access_token)

    def get_text_access_token(self, excluded_tokens: set[str] | None = None) -> str:
        excluded = set(excluded_tokens or set())
        with self._lock:
            candidates = [
                token
                for account in self._accounts.values()
                if account.get("status") not in {"禁用", "异常"}
                   and (token := account.get("access_token") or "")
                   and token not in excluded
            ]
            if not candidates:
                return ""
            access_token = candidates[self._index % len(candidates)]
            self._index += 1
            return access_token

    def mark_text_used(self, access_token: str) -> None:
        if not access_token:
            return
        with self._lock:
            current = self._accounts.get(access_token)
            if current is None:
                return
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            account = self._normalize_account(next_item)
            if account is None:
                return
            self._accounts[access_token] = account
            self._save_accounts()

    def remove_invalid_token(self, access_token: str, event: str) -> bool:
        if not config.auto_remove_invalid_accounts:
            self.update_account(access_token, {"status": "异常", "quota": 0})
            return False
        removed = bool(self.delete_accounts([access_token])["removed"])
        if removed:
            log_service.add(LOG_TYPE_ACCOUNT, "自动移除异常账号",
                            {"source": event, "token": anonymize_token(access_token)})
        elif access_token:
            self.update_account(access_token, {"status": "异常", "quota": 0})
        return removed

    def get_account(self, access_token: str) -> dict | None:
        if not access_token:
            return None
        with self._lock:
            account = self._accounts.get(access_token)
            return dict(account) if account else None

    def list_accounts(self) -> list[dict]:
        with self._lock:
            return [dict(item) for item in self._accounts.values()]

    def list_limited_tokens(self) -> list[str]:
        with self._lock:
            return [
                token
                for item in self._accounts.values()
                if item.get("status") == "限流"
                   and (token := item.get("access_token") or "")
            ]

    def add_accounts(self, tokens: list[str], source_type: str = "web") -> dict:
        tokens = list(dict.fromkeys(token for token in tokens if token))
        if not tokens:
            return {"added": 0, "skipped": 0, "items": self.list_accounts()}

        with self._lock:
            added = 0
            skipped = 0
            for access_token in tokens:
                current = self._accounts.get(access_token)
                if current is None:
                    added += 1
                    current = {}
                else:
                    skipped += 1
                account = self._normalize_account(
                    {
                        **current,
                        "access_token": access_token,
                        "source_type": current.get("source_type") or self._normalize_source_type(source_type),
                        "type": str(current.get("type") or "free"),
                    }
                )
                if account is not None:
                    self._accounts[access_token] = account
            self._save_accounts()
            items = [dict(item) for item in self._accounts.values()]
            log_service.add(LOG_TYPE_ACCOUNT, f"新增 {added} 个账号，跳过 {skipped} 个",
                            {"added": added, "skipped": skipped})
        return {"added": added, "skipped": skipped, "items": items}

    def delete_accounts(self, tokens: list[str]) -> dict:
        target_set = set(token for token in tokens if token)
        if not target_set:
            return {"removed": 0, "items": self.list_accounts()}
        with self._lock:
            removed = sum(self._accounts.pop(token, None) is not None for token in target_set)
            for token in target_set:
                self._image_inflight.pop(token, None)
                self._image_cooldowns.pop(token, None)
            if removed:
                if self._accounts:
                    self._index %= len(self._accounts)
                else:
                    self._index = 0
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, f"删除 {removed} 个账号", {"removed": removed})
            items = [dict(item) for item in self._accounts.values()]
        return {"removed": removed, "items": items}

    def update_account(self, access_token: str, updates: dict) -> dict | None:
        if not access_token:
            return None
        with self._lock:
            current = self._accounts.get(access_token)
            if current is None:
                return None
            account = self._normalize_account({**current, **updates, "access_token": access_token})
            if account is None:
                return None
            if account.get("status") == "限流" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(access_token, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(access_token)})
                return None
            self._accounts[access_token] = account
            self._save_accounts()
            log_service.add(LOG_TYPE_ACCOUNT, "更新账号",
                            {"token": anonymize_token(access_token), "status": account.get("status")})
            return dict(account)
        return None

    def mark_image_result(self, access_token: str, success: bool) -> dict | None:
        if not access_token:
            return None
        self.release_image_slot(access_token)
        with self._lock:
            current = self._accounts.get(access_token)
            if current is None:
                return None
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            image_quota_unknown = bool(next_item.get("image_quota_unknown"))
            if success:
                self._image_cooldowns.pop(access_token, None)
                next_item["success"] = int(next_item.get("success") or 0) + 1
                next_item["last_failure_reason"] = ""
                if not image_quota_unknown:
                    next_item["quota"] = max(0, int(next_item.get("quota") or 0) - 1)
                if not image_quota_unknown and next_item["quota"] == 0:
                    next_item["status"] = "限流"
                    next_item["restore_at"] = next_item.get("restore_at") or None
                elif next_item.get("status") == "限流":
                    next_item["status"] = "正常"
            else:
                next_item["fail"] = int(next_item.get("fail") or 0) + 1
                next_item["last_failed_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                next_item["last_failure_reason"] = "image_generation_failed"
            account = self._normalize_account(next_item)
            if account is None:
                return None
            if account.get("status") == "限流" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(access_token, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(access_token)})
                return None
            self._accounts[access_token] = account
            self._save_accounts()
            return dict(account)
        return None

    def mark_image_limited(self, access_token: str, restore_at: str | None = None) -> dict | None:
        if not access_token:
            return None
        self.release_image_slot(access_token)
        with self._lock:
            current = self._accounts.get(access_token)
            if current is None:
                return None
            next_item = dict(current)
            next_item["last_used_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            next_item["fail"] = int(next_item.get("fail") or 0) + 1
            next_item["last_failed_at"] = next_item["last_used_at"]
            next_item["last_failure_reason"] = "image_quota_limited"
            next_item["quota"] = 0
            next_item["image_quota_unknown"] = False
            next_item["status"] = "限流"
            if restore_at:
                next_item["restore_at"] = restore_at
            account = self._normalize_account(next_item)
            if account is None:
                return None
            if config.auto_remove_rate_limited_accounts:
                self._accounts.pop(access_token, None)
                self._image_cooldowns.pop(access_token, None)
                self._save_accounts()
                log_service.add(LOG_TYPE_ACCOUNT, "自动移除限流账号", {"token": anonymize_token(access_token)})
                return None
            self._accounts[access_token] = account
            self._image_cooldowns.pop(access_token, None)
            self._save_accounts()
            log_service.add(
                LOG_TYPE_ACCOUNT,
                "图片额度耗尽，账号已标记限流",
                {"token": anonymize_token(access_token), "restore_at": account.get("restore_at")},
            )
            return dict(account)

    def _update_account_without_save(self, access_token: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            current = self._accounts.get(access_token)
            if current is None:
                return None
            account = self._normalize_account({**current, **updates, "access_token": access_token})
            if account is None:
                return None
            if account.get("status") == "闄愭祦" and config.auto_remove_rate_limited_accounts:
                self._accounts.pop(access_token, None)
                return None
            self._accounts[access_token] = account
            return dict(account)

    def _flush_accounts(self) -> None:
        with self._lock:
            self._save_accounts()

    def fetch_remote_info(
        self,
        access_token: str,
        event: str = "fetch_remote_info",
        *,
        save: bool = True,
    ) -> dict[str, Any] | None:
        if not access_token:
            raise ValueError("access_token is required")

        try:
            from services.openai_backend_api import InvalidAccessTokenError, OpenAIBackendAPI
            result = OpenAIBackendAPI(access_token).get_user_info()
        except InvalidAccessTokenError:
            self.remove_invalid_token(access_token, event)
            raise
        if isinstance(result, dict):
            result = {**result, "last_refreshed_at": self._now_text()}
        if save:
            return self.update_account(access_token, result)
        return self._update_account_without_save(access_token, result)

    def _fetch_remote_info_for_refresh(self, access_token: str, event: str) -> dict[str, Any] | None:
        try:
            return self.fetch_remote_info(access_token, event, save=False)
        except TypeError as exc:
            if "save" not in str(exc):
                raise
            return self.fetch_remote_info(access_token, event)

    def refresh_accounts(self, access_tokens: list[str]) -> dict[str, Any]:
        access_tokens = list(dict.fromkeys(token for token in access_tokens if token))
        if not access_tokens:
            return {"refreshed": 0, "errors": [], "items": self.list_accounts()}

        refreshed = 0
        errors = []
        max_workers = min(config.account_refresh_concurrency, len(access_tokens))

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(self._fetch_remote_info_for_refresh, token, "refresh_accounts"): token
                for token in access_tokens
            }
            for future in as_completed(futures):
                try:
                    account = future.result()
                except Exception as exc:
                    errors.append({"token": anonymize_token(futures[future]), "error": str(exc)})
                    continue
                if account is not None:
                    refreshed += 1

        self._flush_accounts()

        return {
            "refreshed": refreshed,
            "errors": errors,
            "items": self.list_accounts(),
        }

    @staticmethod
    def _now_text() -> str:
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def _prune_refresh_jobs_locked(self) -> None:
        if len(self._refresh_jobs) <= 20:
            return
        finished = [
            (str(job.get("updated_at") or ""), job_id)
            for job_id, job in self._refresh_jobs.items()
            if job.get("status") != "running"
        ]
        for _, job_id in sorted(finished)[: max(0, len(self._refresh_jobs) - 20)]:
            self._refresh_jobs.pop(job_id, None)

    def _refresh_job_snapshot(self, job: dict[str, Any]) -> dict[str, Any]:
        snapshot = dict(job)
        snapshot["errors"] = [dict(item) for item in job.get("errors") or []]
        snapshot["items"] = self.list_accounts()
        return snapshot

    def start_refresh_job(self, access_tokens: list[str]) -> dict[str, Any]:
        tokens = list(dict.fromkeys(token for token in access_tokens if token))
        if not tokens:
            raise ValueError("access_tokens is required")

        job_id = uuid.uuid4().hex
        now = self._now_text()
        job = {
            "id": job_id,
            "status": "running",
            "total": len(tokens),
            "done": 0,
            "refreshed": 0,
            "failed": 0,
            "errors": [],
            "started_at": now,
            "updated_at": now,
            "finished_at": None,
        }
        with self._refresh_jobs_lock:
            self._prune_refresh_jobs_locked()
            self._refresh_jobs[job_id] = job

        Thread(target=self._run_refresh_job, args=(job_id, tokens), daemon=True).start()
        return self.get_refresh_job(job_id) or self._refresh_job_snapshot(job)

    def get_refresh_job(self, job_id: str) -> dict[str, Any] | None:
        with self._refresh_jobs_lock:
            job = self._refresh_jobs.get(job_id)
            if job is None:
                return None
            snapshot = dict(job)
            snapshot["errors"] = [dict(item) for item in job.get("errors") or []]
        snapshot["items"] = self.list_accounts()
        return snapshot

    def _run_refresh_job(self, job_id: str, access_tokens: list[str]) -> None:
        max_workers = min(config.account_refresh_concurrency, len(access_tokens))
        pending_saves = 0
        try:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {
                    executor.submit(self._fetch_remote_info_for_refresh, token, "refresh_accounts_job"): token
                    for token in access_tokens
                }
                for future in as_completed(futures):
                    token = futures[future]
                    error = None
                    refreshed = False
                    try:
                        account = future.result()
                    except Exception as exc:
                        error = str(exc)
                    else:
                        refreshed = account is not None
                    if refreshed:
                        pending_saves += 1
                        if pending_saves >= REFRESH_SAVE_BATCH_SIZE:
                            self._flush_accounts()
                            pending_saves = 0
                    with self._refresh_jobs_lock:
                        job = self._refresh_jobs.get(job_id)
                        if job is None:
                            return
                        job["done"] = int(job.get("done") or 0) + 1
                        if refreshed:
                            job["refreshed"] = int(job.get("refreshed") or 0) + 1
                        else:
                            job["failed"] = int(job.get("failed") or 0) + 1
                            errors = job.setdefault("errors", [])
                            if isinstance(errors, list):
                                errors.append({"token": anonymize_token(token), "error": error or "refresh failed"})
                        job["updated_at"] = self._now_text()
            self._flush_accounts()
            with self._refresh_jobs_lock:
                job = self._refresh_jobs.get(job_id)
                if job is not None:
                    job["status"] = "finished"
                    job["updated_at"] = self._now_text()
                    job["finished_at"] = job["updated_at"]
        except Exception as exc:
            with self._refresh_jobs_lock:
                job = self._refresh_jobs.get(job_id)
                if job is not None:
                    job["status"] = "error"
                    job["error"] = str(exc)
                    job["updated_at"] = self._now_text()
                    job["finished_at"] = job["updated_at"]


account_service = AccountService(config.get_storage_backend())
