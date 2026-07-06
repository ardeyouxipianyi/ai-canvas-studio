from __future__ import annotations

import base64
import json
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests

from services.config import DATA_DIR, config
from services.content_filter import request_text
from services.image_provider_service import ProviderRequest, image_provider_service
from services.log_service import LOG_TYPE_CALL, log_service, _collect_usage
from services.protocol.conversation import save_image_bytes

TASK_STATUS_QUEUED = "queued"
TASK_STATUS_RUNNING = "running"
TASK_STATUS_SUCCESS = "success"
TASK_STATUS_ERROR = "error"
TASK_STATUS_CANCELLED = "cancelled"
TERMINAL_STATUSES = {TASK_STATUS_SUCCESS, TASK_STATUS_ERROR, TASK_STATUS_CANCELLED}
UNFINISHED_STATUSES = {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING}
TASK_STAGE_QUEUED = "queued"
TASK_STAGE_RUNNING = "running"
TASK_STAGE_ARCHIVING = "archiving"
TASK_STAGE_SUCCESS = "success"
TASK_STAGE_ERROR = "error"
TASK_STAGE_CANCELLED = "cancelled"
RETRYABLE_ERROR_MARKERS = (
    "timeout",
    "timed out",
    "connection",
    "network",
    "temporarily",
    "502",
    "503",
    "504",
    "5xx",
    "server error",
)
NON_RETRYABLE_ERROR_MARKERS = (
    "401",
    "403",
    "400",
    "quota",
    "no available image quota",
    "invalid",
    "api key",
    "not support",
    "disabled",
    "required",
)


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _timestamp(value: object) -> float:
    if not isinstance(value, str) or not value.strip():
        return 0.0
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:26], fmt).timestamp()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _progress(value: object, fallback: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    return max(0, min(100, number))


def _perceived_progress(task: dict[str, Any]) -> tuple[int, str]:
    status = _clean(task.get("status"))
    base_progress = _progress(task.get("progress"), 100 if status in TERMINAL_STATUSES else 0)
    message = _clean(task.get("progress_message"))

    if status == TASK_STATUS_QUEUED:
        queued_at = _timestamp(task.get("created_at")) or time.time()
        elapsed = max(0.0, time.time() - queued_at)
        queued_progress = min(9, max(base_progress, int(elapsed / 2) + 1 if elapsed >= 2 else base_progress))
        return queued_progress, message or "排队中"

    if status != TASK_STATUS_RUNNING or base_progress >= 85:
        return base_progress, message

    stage_started_at = _timestamp(task.get("updated_at")) or _timestamp(task.get("created_at")) or time.time()
    elapsed = max(0.0, time.time() - stage_started_at)
    simulated = int(15 + 68 * (1 - (2 ** (-elapsed / 45))))
    progress = min(82, max(base_progress, simulated))
    if progress < 28:
        message = "正在连接上游"
    elif progress < 58:
        message = "上游生成中"
    elif progress < 78:
        message = "等待上游返回"
    else:
        message = "等待结果确认"
    return progress, message


def _owner_id(identity: dict[str, object]) -> str:
    return _clean(identity.get("id")) or "anonymous"


def _task_key(owner_id: str, task_id: str) -> str:
    return f"{owner_id}:{task_id}"


def _collect_image_urls(data: list[Any]) -> list[str]:
    urls: list[str] = []
    for item in data:
        if isinstance(item, dict):
            url = item.get("url")
            if isinstance(url, str) and url:
                urls.append(url)
    return urls


def _is_retryable_error(error: Exception) -> bool:
    message = str(error or "").lower()
    if any(marker in message for marker in NON_RETRYABLE_ERROR_MARKERS):
        return False
    return any(marker in message for marker in RETRYABLE_ERROR_MARKERS)


def _decode_b64_image(value: str) -> bytes:
    candidate = _clean(value)
    if candidate.startswith("data:") and "," in candidate:
        candidate = candidate.split(",", 1)[1]
    try:
        return base64.b64decode(candidate, validate=True)
    except Exception as exc:
        raise RuntimeError("provider returned invalid base64 image data") from exc


def _is_http_url(value: str) -> bool:
    parsed = urlparse(_clean(value))
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _is_local_image_url(url: str, base_url: str) -> bool:
    base = _clean(base_url).rstrip("/")
    return bool(base and _clean(url).startswith(f"{base}/images/"))


def _download_image_url(url: str) -> bytes:
    response = requests.get(url, timeout=120)
    if response.status_code >= 400:
        raise RuntimeError(f"failed to download provider image: HTTP {response.status_code}")
    content = bytes(response.content or b"")
    if not content:
        raise RuntimeError("failed to download provider image: empty response")
    return content


def archive_image_outputs(data: list[Any], base_url: str, owner_id: str) -> list[Any]:
    archived_items: list[Any] = []
    for item in data:
        if not isinstance(item, dict):
            archived_items.append(item)
            continue
        archived = dict(item)
        image_data: bytes | None = None
        b64_json = _clean(archived.get("b64_json"))
        url = _clean(archived.get("url"))
        if b64_json:
            image_data = _decode_b64_image(b64_json)
        elif url and _is_http_url(url) and not _is_local_image_url(url, base_url):
            image_data = _download_image_url(url)
            archived["original_url"] = url
        if image_data:
            archived["url"] = save_image_bytes(image_data, base_url, owner_id)
            archived.pop("b64_json", None)
        archived_items.append(archived)
    return archived_items


def _public_task(task: dict[str, Any]) -> dict[str, Any]:
    progress, progress_message = _perceived_progress(task)
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "provider_id": task.get("provider_id"),
        "provider_name": task.get("provider_name"),
        "provider_type": task.get("provider_type"),
        "model": task.get("model"),
        "size": task.get("size"),
        "quality": task.get("quality"),
        "stage": task.get("stage") or task.get("status"),
        "attempt": int(task.get("attempt") or 0),
        "duration_ms": int(task.get("duration_ms") or 0),
        "progress": progress,
        "progress_message": progress_message,
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if isinstance(task.get("usage"), dict):
        item["usage"] = task.get("usage")
    if int(task.get("image_width") or 0) > 0:
        item["image_width"] = int(task.get("image_width") or 0)
    if int(task.get("image_height") or 0) > 0:
        item["image_height"] = int(task.get("image_height") or 0)
    if task.get("data") is not None:
        item["data"] = task.get("data")
    if task.get("error"):
        item["error"] = task.get("error")
    if task.get("message"):
        item["message"] = task.get("message")
    return item


class ImageTaskService:
    def __init__(
        self,
        path: Path,
        *,
        generation_handler: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        edit_handler: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        retention_days_getter: Callable[[], int] | None = None,
        provider_service: Any | None = None,
        image_archiver: Callable[[list[Any], str, str], list[Any]] | None = None,
    ):
        self.path = path
        self.generation_handler = generation_handler
        self.edit_handler = edit_handler
        self.retention_days_getter = retention_days_getter or (lambda: config.image_retention_days)
        self.provider_service = provider_service or image_provider_service
        self.image_archiver = image_archiver or archive_image_outputs
        self._lock = threading.RLock()
        self._tasks: dict[str, dict[str, Any]] = {}
        self._provider_locks: dict[str, threading.Semaphore] = {}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
            self._tasks = self._load_locked()
            changed = self._recover_unfinished_locked()
            changed = self._cleanup_locked() or changed
            if changed:
                self._save_locked()

    def submit_generation(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        provider_id: str = "",
        quality: str = "auto",
    ) -> dict[str, Any]:
        provider = self.provider_service.resolve_provider(provider_id)
        payload = {
            "prompt": prompt,
            "provider_id": provider["id"],
            "provider_name": provider["name"],
            "provider_type": provider["type"],
            "model": model or provider["default_model"],
            "n": 1,
            "size": size or provider.get("default_size") or "",
            "quality": quality or provider.get("default_quality") or "auto",
            "response_format": "url",
            "base_url": base_url,
            "owner_id": _owner_id(identity),
        }
        return self._submit(identity, client_task_id=client_task_id, mode="generate", payload=payload)

    def submit_edit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        size: str | None,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        provider_id: str = "",
        quality: str = "auto",
    ) -> dict[str, Any]:
        provider = self.provider_service.resolve_provider(provider_id)
        capabilities = provider.get("capabilities", {})
        if not capabilities.get("edit"):
            raise ValueError("Provider does not support image edits.")
        payload = {
            "prompt": prompt,
            "images": images,
            "provider_id": provider["id"],
            "provider_name": provider["name"],
            "provider_type": provider["type"],
            "model": model or provider["default_model"],
            "n": 1,
            "size": size or provider.get("default_size") or "",
            "quality": quality or provider.get("default_quality") or "auto",
            "response_format": "url",
            "base_url": base_url,
            "owner_id": _owner_id(identity),
        }
        return self._submit(identity, client_task_id=client_task_id, mode="edit", payload=payload)

    def submit_reverse_prompt(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        prompt: str,
        model: str,
        base_url: str,
        images: list[tuple[bytes, str, str]],
        provider_id: str = "",
    ) -> dict[str, Any]:
        provider = self.provider_service.resolve_provider(provider_id, purpose="reverse_prompt")
        capabilities = provider.get("capabilities", {})
        if not capabilities.get("reverse_prompt"):
            raise ValueError("Provider does not support reverse prompt.")
        payload = {
            "prompt": prompt,
            "images": images,
            "provider_id": provider["id"],
            "provider_name": provider["name"],
            "provider_type": provider["type"],
            "model": model or provider.get("default_reverse_prompt_model") or provider["default_model"],
            "n": 1,
            "size": None,
            "response_format": "url",
            "message_as_error": False,
            "base_url": base_url,
            "owner_id": _owner_id(identity),
        }
        return self._submit(identity, client_task_id=client_task_id, mode="reverse_prompt", payload=payload)

    def list_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        with self._lock:
            if self._cleanup_locked():
                self._save_locked()
            items = []
            missing_ids = []
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                else:
                    items.append(_public_task(task))
            if not requested_ids:
                items = [
                    _public_task(task)
                    for task in self._tasks.values()
                    if task.get("owner_id") == owner
                ]
                items.sort(key=lambda item: str(item.get("updated_at") or ""), reverse=True)
                missing_ids = []
            return {"items": items, "missing_ids": missing_ids}

    def cancel_tasks(self, identity: dict[str, object], task_ids: list[str]) -> dict[str, Any]:
        owner = _owner_id(identity)
        requested_ids = [_clean(task_id) for task_id in task_ids if _clean(task_id)]
        cancelled = []
        unchanged = []
        missing_ids = []
        now = _now_iso()
        with self._lock:
            for task_id in requested_ids:
                task = self._tasks.get(_task_key(owner, task_id))
                if task is None:
                    missing_ids.append(task_id)
                    continue
                if task.get("status") in TERMINAL_STATUSES:
                    unchanged.append(_public_task(task))
                    continue
                task["status"] = TASK_STATUS_CANCELLED
                task["stage"] = TASK_STAGE_CANCELLED
                task["error"] = "任务已取消"
                task["data"] = []
                task["progress"] = 100
                task["progress_message"] = "已取消"
                task["updated_at"] = now
                cancelled.append(_public_task(task))
            if cancelled:
                self._save_locked()
        return {"items": [*cancelled, *unchanged], "cancelled_ids": [str(item.get("id")) for item in cancelled], "missing_ids": missing_ids}

    def _submit(
        self,
        identity: dict[str, object],
        *,
        client_task_id: str,
        mode: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        task_id = _clean(client_task_id)
        if not task_id:
            raise ValueError("client_task_id is required")
        owner = _owner_id(identity)
        key = _task_key(owner, task_id)
        now = _now_iso()
        should_start = False
        with self._lock:
            cleaned = self._cleanup_locked()
            task = self._tasks.get(key)
            if task is not None:
                if cleaned:
                    self._save_locked()
                return _public_task(task)
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": TASK_STATUS_QUEUED,
                "mode": mode,
                "provider_id": _clean(payload.get("provider_id")),
                "provider_name": _clean(payload.get("provider_name")),
                "provider_type": _clean(payload.get("provider_type")),
                "model": _clean(payload.get("model"), "gpt-image-2"),
                "size": _clean(payload.get("size")),
                "quality": _clean(payload.get("quality"), "auto"),
                "stage": TASK_STAGE_QUEUED,
                "attempt": 0,
                "duration_ms": 0,
                "progress": 0,
                "progress_message": "排队中",
                "created_at": now,
                "updated_at": now,
            }
            self._tasks[key] = task
            self._save_locked()
            should_start = True

        if should_start:
            thread = threading.Thread(
                target=self._run_task,
                args=(key, mode, payload, dict(identity), _clean(payload.get("model"), "gpt-image-2")),
                name=f"image-task-{task_id[:16]}",
                daemon=True,
            )
            thread.start()
        return _public_task(task)

    def _run_task(
        self,
        key: str,
        mode: str,
        payload: dict[str, Any],
        identity: dict[str, object],
        model: str,
    ) -> None:
        started = time.time()
        provider_id = _clean(payload.get("provider_id"))
        identity["_provider_id"] = _clean(payload.get("provider_id"))
        identity["_provider_name"] = _clean(payload.get("provider_name"))
        identity["_provider_type"] = _clean(payload.get("provider_type"))
        self._update_task(key, stage=TASK_STAGE_RUNNING)
        self._update_task(key, status=TASK_STATUS_RUNNING, error="", progress=15, progress_message="正在调用上游")
        try:
            if self._is_cancelled(key):
                return
            result = self._call_task_provider(key, mode, payload)
            if self._is_cancelled(key):
                return
            if not isinstance(result, dict):
                raise RuntimeError("image task returned streaming result unexpectedly")
            self._update_task(key, progress=85, progress_message="正在整理结果")
            self._update_task(key, stage=TASK_STAGE_ARCHIVING)
            data = result.get("data")
            message = _clean(result.get("message"))
            if mode == "reverse_prompt":
                if not message and isinstance(data, list) and data and isinstance(data[0], dict):
                    message = _clean(data[0].get("revised_prompt"))
                if not message:
                    raise RuntimeError("reverse prompt task returned no text")
                self._update_task(key, status=TASK_STATUS_SUCCESS, data=[], message=message, error="", progress=100, progress_message="已完成")
                self._log_call(
                    identity,
                    mode,
                    model,
                    started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=[],
                usage=result.get("usage"),
            )
                self._update_task(key, stage=TASK_STAGE_SUCCESS, duration_ms=int((time.time() - started) * 1000), usage=result.get("usage") if isinstance(result.get("usage"), dict) else None)
                self._record_provider_result(provider_id, ok=True, latency_ms=int((time.time() - started) * 1000))
                return
            if not isinstance(data, list) or not data:
                message = _clean(result.get("message")) or "image task returned no image data"
                raise RuntimeError(message)
            data = self.image_archiver(data, _clean(payload.get("base_url")), _clean(payload.get("owner_id")))
            self._update_task(key, status=TASK_STATUS_SUCCESS, data=data, error="", progress=100, progress_message="已完成")
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用完成",
                request_preview=request_text(payload.get("prompt")),
                urls=_collect_image_urls(data),
                usage=result.get("usage"),
            )
            self._update_task(key, stage=TASK_STAGE_SUCCESS, duration_ms=int((time.time() - started) * 1000), usage=result.get("usage") if isinstance(result.get("usage"), dict) else None)
            self._record_provider_result(provider_id, ok=True, latency_ms=int((time.time() - started) * 1000))
        except Exception as exc:
            if self._is_cancelled(key):
                return
            error_message = str(exc) or "image task failed"
            self._update_task(key, status=TASK_STATUS_ERROR, error=error_message, data=[], message="", progress=100, progress_message="失败")
            self._log_call(
                identity,
                mode,
                model,
                started,
                "调用失败",
                request_preview=request_text(payload.get("prompt")),
                status="failed",
                error=error_message,
            )
            self._update_task(key, stage=TASK_STAGE_ERROR, duration_ms=int((time.time() - started) * 1000))
            self._record_provider_result(provider_id, ok=False, latency_ms=int((time.time() - started) * 1000), error=error_message)

    def _call_task_provider(self, key: str, mode: str, payload: dict[str, Any]) -> dict[str, Any]:
        provider_id = _clean(payload.get("provider_id"))
        if not provider_id:
            raise RuntimeError("No image provider selected.")
        max_attempts = 2
        last_error: Exception | None = None
        for attempt in range(1, max_attempts + 1):
            self._update_task(key, attempt=attempt, stage=TASK_STAGE_RUNNING)
            try:
                provider_request = ProviderRequest(
                    provider_id=provider_id,
                    prompt=_clean(payload.get("prompt")),
                    model=_clean(payload.get("model")),
                    size=_clean(payload.get("size")),
                    quality=_clean(payload.get("quality"), "auto"),
                    n=1,
                    response_format=_clean(payload.get("response_format"), "url"),
                    images=payload.get("images") if isinstance(payload.get("images"), list) else None,
                    message_as_error=bool(payload.get("message_as_error", True)),
                    owner_id=_clean(payload.get("owner_id")),
                )
                with self._provider_lock(provider_id):
                    if mode == "reverse_prompt":
                        return self.provider_service.reverse_prompt(provider_request)
                    if mode == "edit":
                        return self.provider_service.edit(provider_request)
                    return self.provider_service.generate(provider_request)
            except Exception as exc:
                last_error = exc
                if attempt >= max_attempts or not _is_retryable_error(exc) or self._is_cancelled(key):
                    raise
                self._update_task(key, progress=24, progress_message="上游暂时失败，正在重试")
                time.sleep(min(2.0, 0.4 * attempt))
        raise last_error or RuntimeError("image task failed")

    def _provider_lock(self, provider_id: str) -> threading.Semaphore:
        with self._lock:
            lock = self._provider_locks.get(provider_id)
            if lock is None:
                lock = threading.Semaphore(2)
                self._provider_locks[provider_id] = lock
            return lock

    def _record_provider_result(self, provider_id: str, *, ok: bool, latency_ms: int = 0, error: str = "") -> None:
        if not provider_id or not hasattr(self.provider_service, "record_provider_result"):
            return
        try:
            self.provider_service.record_provider_result(provider_id, ok=ok, latency_ms=latency_ms, error=error)
        except Exception:
            pass

    def _log_call(
        self,
        identity: dict[str, object],
        mode: str,
        model: str,
        started: float,
        suffix: str,
        *,
        request_preview: str = "",
        status: str = "success",
        error: str = "",
        urls: list[str] | None = None,
        usage: object = None,
    ) -> None:
        endpoint = "/api/image-tasks/reverse-prompts" if mode == "reverse_prompt" else "/api/image-tasks/edits" if mode == "edit" else "/api/image-tasks/generations"
        summary_prefix = "反推提示词" if mode == "reverse_prompt" else "图生图" if mode == "edit" else "文生图"
        detail = {
            "key_id": identity.get("id"),
            "key_name": identity.get("name"),
            "role": identity.get("role"),
            "endpoint": endpoint,
            "model": model,
            "provider_id": identity.get("_provider_id"),
            "provider_name": identity.get("_provider_name"),
            "provider_type": identity.get("_provider_type"),
            "started_at": datetime.fromtimestamp(started).strftime("%Y-%m-%d %H:%M:%S"),
            "ended_at": _now_iso(),
            "duration_ms": int((time.time() - started) * 1000),
            "status": status,
        }
        if request_preview:
            detail["request_text"] = request_preview
        if error:
            detail["error"] = error
        if urls:
            detail["urls"] = list(dict.fromkeys(urls))
        token_usage = _collect_usage({"usage": usage} if isinstance(usage, dict) else None)
        if token_usage:
            detail["usage"] = token_usage
        try:
            log_service.add(LOG_TYPE_CALL, f"{summary_prefix}{suffix}", detail)
        except Exception:
            pass
        try:
            from services.auth_service import auth_service

            auth_service.record_usage(
                identity,
                endpoint=endpoint,
                status=status,
                duration_ms=int(detail["duration_ms"]),
                generated_images=len(list(dict.fromkeys(urls or []))),
                token_usage=token_usage,
            )
        except Exception:
            pass

    def _update_task(self, key: str, **updates: Any) -> None:
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                return
            if task.get("status") == TASK_STATUS_CANCELLED and updates.get("status") != TASK_STATUS_CANCELLED:
                return
            task.update(updates)
            task["updated_at"] = _now_iso()
            self._save_locked()

    def _is_cancelled(self, key: str) -> bool:
        with self._lock:
            task = self._tasks.get(key)
            return bool(task and task.get("status") == TASK_STATUS_CANCELLED)

    def _load_locked(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        raw_items = raw.get("tasks") if isinstance(raw, dict) else raw
        if not isinstance(raw_items, list):
            return {}
        tasks: dict[str, dict[str, Any]] = {}
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            task_id = _clean(item.get("id"))
            owner = _clean(item.get("owner_id"))
            if not task_id or not owner:
                continue
            status = _clean(item.get("status"))
            if status not in {TASK_STATUS_QUEUED, TASK_STATUS_RUNNING, TASK_STATUS_SUCCESS, TASK_STATUS_ERROR, TASK_STATUS_CANCELLED}:
                status = TASK_STATUS_ERROR
            raw_mode = _clean(item.get("mode"))
            mode = raw_mode if raw_mode in {"generate", "edit", "reverse_prompt"} else "generate"
            task = {
                "id": task_id,
                "owner_id": owner,
                "status": status,
                "mode": mode,
                "provider_id": _clean(item.get("provider_id")),
                "provider_name": _clean(item.get("provider_name")),
                "provider_type": _clean(item.get("provider_type")),
                "model": _clean(item.get("model"), "gpt-image-2"),
                "size": _clean(item.get("size")),
                "quality": _clean(item.get("quality"), "auto"),
                "progress": _progress(item.get("progress"), 100 if status in TERMINAL_STATUSES else 0),
                "progress_message": _clean(item.get("progress_message")),
                "created_at": _clean(item.get("created_at"), _now_iso()),
                "updated_at": _clean(item.get("updated_at"), _clean(item.get("created_at"), _now_iso())),
            }
            data = item.get("data")
            if isinstance(data, list):
                task["data"] = data
            error = _clean(item.get("error"))
            if error:
                task["error"] = error
            message = _clean(item.get("message"))
            if message:
                task["message"] = message
            tasks[_task_key(owner, task_id)] = task
        return tasks

    def _save_locked(self) -> None:
        items = sorted(self._tasks.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"tasks": items}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def _recover_unfinished_locked(self) -> bool:
        changed = False
        for task in self._tasks.values():
            if task.get("status") in UNFINISHED_STATUSES:
                task["status"] = TASK_STATUS_ERROR
                task["error"] = "服务已重启，未完成的图片任务已中断"
                task["progress"] = 100
                task["progress_message"] = "失败"
                task["updated_at"] = _now_iso()
                changed = True
        return changed

    def _cleanup_locked(self) -> bool:
        try:
            retention_days = max(1, int(self.retention_days_getter()))
        except Exception:
            retention_days = 30
        cutoff = time.time() - retention_days * 86400
        removed_keys = [
            key
            for key, task in self._tasks.items()
            if task.get("status") in TERMINAL_STATUSES and _timestamp(task.get("updated_at")) < cutoff
        ]
        for key in removed_keys:
            self._tasks.pop(key, None)
        return bool(removed_keys)


image_task_service = ImageTaskService(DATA_DIR / "image_tasks.json")
