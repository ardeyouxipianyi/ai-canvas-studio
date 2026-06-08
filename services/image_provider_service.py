from __future__ import annotations

import json
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from curl_cffi import requests

from services.config import DATA_DIR, config
from utils.helper import decode_image_source

PROVIDER_TYPE_OPENAI_COMPATIBLE = "openai_compatible"
DEFAULT_PROVIDER_TIMEOUT_SECS = 180


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean(value: object, default: str = "") -> str:
    return str(value or default).strip()


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _positive_int(value: object, default: int, minimum: int = 1, maximum: int = 600) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return min(maximum, max(minimum, number))


def _capabilities(value: object) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    return {
        "generate": _bool(source.get("generate"), True),
        "edit": _bool(source.get("edit"), True),
        "reverse_prompt": _bool(source.get("reverse_prompt"), False),
    }


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(_clean(item) for item in value if _clean(item)))


def _models_from_response(data: object) -> list[str]:
    items = data.get("data") if isinstance(data, dict) else []
    models: list[str] = []
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and _clean(item.get("id")):
                models.append(_clean(item.get("id")))
    return list(dict.fromkeys(models))


def _new_id() -> str:
    return f"provider_{uuid.uuid4().hex[:12]}"


def _normalize_base_url(value: object) -> str:
    base_url = _clean(value)
    return base_url.rstrip(" /。．.，,、；;")


def _looks_like_url(value: object) -> bool:
    lowered = _clean(value).lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def _provider_warnings(provider: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    base_url = _normalize_base_url(provider.get("base_url"))
    if base_url and not base_url.lower().endswith("/v1"):
        warnings.append("OpenAI Compatible Base URL 通常需要以 /v1 结尾，否则生图接口可能返回 404/405。")
    if _looks_like_url(provider.get("api_key")):
        warnings.append("API Key 看起来像 URL。请填写真正的密钥，不要填写服务地址。")
    return warnings


def _normalize_provider(raw: object, *, existing: dict[str, Any] | None = None) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    existing = existing or {}
    provider_id = _clean(source.get("id")) or _clean(existing.get("id")) or _new_id()
    provider_type = _clean(source.get("type"), _clean(existing.get("type"), PROVIDER_TYPE_OPENAI_COMPATIBLE))
    if provider_type != PROVIDER_TYPE_OPENAI_COMPATIBLE:
        provider_type = PROVIDER_TYPE_OPENAI_COMPATIBLE
    api_key = _clean(source.get("api_key"))
    if not api_key and _bool(source.get("keep_api_key"), False):
        api_key = _clean(existing.get("api_key"))
    return {
        "id": provider_id,
        "name": _clean(source.get("name"), _clean(existing.get("name"), "OpenAI Compatible")) or "OpenAI Compatible",
        "type": provider_type,
        "enabled": _bool(source.get("enabled"), _bool(existing.get("enabled"), True)),
        "base_url": _normalize_base_url(source.get("base_url") if "base_url" in source else existing.get("base_url")),
        "api_key": api_key,
        "default_model": _clean(source.get("default_model"), _clean(existing.get("default_model"), "gpt-image-1")) or "gpt-image-1",
        "default_reverse_prompt_model": _clean(
            source.get("default_reverse_prompt_model"),
            _clean(existing.get("default_reverse_prompt_model"), _clean(source.get("default_model"), _clean(existing.get("default_model"), "gpt-image-1"))),
        ) or "gpt-image-1",
        "default_size": _clean(source.get("default_size"), _clean(existing.get("default_size"))),
        "default_quality": _clean(source.get("default_quality"), _clean(existing.get("default_quality"), "auto")) or "auto",
        "timeout_secs": _positive_int(source.get("timeout_secs", existing.get("timeout_secs")), DEFAULT_PROVIDER_TIMEOUT_SECS),
        "capabilities": _capabilities(source.get("capabilities", existing.get("capabilities"))),
        "last_success_at": _clean(existing.get("last_success_at")) or None,
        "last_error_at": _clean(existing.get("last_error_at")) or None,
        "last_error": _clean(existing.get("last_error")),
        "latency_ms": int(_positive_int(existing.get("latency_ms"), 0, minimum=0, maximum=24 * 60 * 60 * 1000)),
        "success_count": int(_positive_int(existing.get("success_count"), 0, minimum=0, maximum=999999999)),
        "error_count": int(_positive_int(existing.get("error_count"), 0, minimum=0, maximum=999999999)),
        "model_cache": _string_list(existing.get("model_cache")),
        "model_cache_updated_at": _clean(existing.get("model_cache_updated_at")) or None,
        "created_at": _clean(existing.get("created_at")) or str(_now_ms()),
        "updated_at": str(_now_ms()),
    }


def _public_provider(provider: dict[str, Any]) -> dict[str, Any]:
    item = {key: value for key, value in provider.items() if key != "api_key"}
    item["has_api_key"] = bool(_clean(provider.get("api_key")))
    item["warnings"] = _provider_warnings(provider)
    return item


def _extract_response_error(response: requests.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict):
                return _clean(error.get("message")) or _clean(error)
            if error:
                return _clean(error)
    except Exception:
        pass
    return response.text[:500] if response.text else f"HTTP {response.status_code}"


def _provider_http_error(response: requests.Response, path: str) -> RuntimeError:
    message = _extract_response_error(response)
    if response.status_code == 405 and path.startswith("/images/"):
        message = f"{message}。OpenAI Compatible Base URL 通常需要包含 /v1，例如 https://host/v1。"
    if response.status_code == 401:
        message = f"{message}。请检查模型服务 API Key 是否正确。"
    return RuntimeError(message)


def _normalize_result(data: object) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise RuntimeError("provider returned invalid JSON")
    raw_items = data.get("data")
    if not isinstance(raw_items, list):
        raw_items = []
    items: list[dict[str, Any]] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            continue
        item: dict[str, Any] = {}
        b64_json = _clean(raw_item.get("b64_json"))
        url = _clean(raw_item.get("url"))
        revised_prompt = _clean(raw_item.get("revised_prompt"))
        if b64_json:
            item["b64_json"] = b64_json
        if url:
            item["url"] = url
        if revised_prompt:
            item["revised_prompt"] = revised_prompt
        if item:
            items.append(item)
    result: dict[str, Any] = {
        "created": data.get("created") or int(time.time()),
        "data": items,
    }
    if isinstance(data.get("usage"), dict):
        result["usage"] = data.get("usage")
    message = _clean(data.get("message"))
    if message:
        result["message"] = message
    return result


@dataclass
class ProviderRequest:
    provider_id: str
    prompt: str
    model: str
    size: str = ""
    quality: str = "auto"
    n: int = 1
    response_format: str = "url"
    images: list[tuple[bytes, str, str]] | None = None
    message_as_error: bool = True
    owner_id: str = ""


class ImageProviderService:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._providers = self._load()

    def _load(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        items = raw.get("providers") if isinstance(raw, dict) else raw
        if not isinstance(items, list):
            return []
        providers: list[dict[str, Any]] = []
        for item in items:
            provider = _normalize_provider(item)
            if provider["base_url"]:
                providers.append(provider)
        return providers

    def _save(self) -> None:
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp_path.write_text(json.dumps({"providers": self._providers}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tmp_path.replace(self.path)

    def reload(self) -> None:
        with self._lock:
            self._providers = self._load()

    def list_providers(self) -> dict[str, Any]:
        with self._lock:
            providers = [_public_provider(provider) for provider in self._providers]
            default_provider = self.get_default_provider(required=False)
            default_reverse_provider = self.get_default_reverse_prompt_provider(required=False)
            return {
                "items": providers,
                "default_provider_id": default_provider.get("id") if default_provider else "",
                "default_reverse_provider_id": default_reverse_provider.get("id") if default_reverse_provider else "",
            }

    def save_provider(self, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            provider_id = _clean(data.get("id"))
            existing = None
            existing_index = -1
            for index, item in enumerate(self._providers):
                if item.get("id") == provider_id:
                    existing = item
                    existing_index = index
                    break
            provider = _normalize_provider(data, existing=existing)
            if not provider["base_url"]:
                raise ValueError("base_url is required")
            if not provider["api_key"]:
                raise ValueError("api_key is required")
            if _looks_like_url(provider["api_key"]):
                raise ValueError("api_key must be an API key, not a URL.")
            if existing_index >= 0:
                self._providers[existing_index] = provider
            else:
                self._providers.append(provider)
            make_default = _bool(data.get("make_default"), False) or _bool(data.get("make_generation_default"), False)
            make_reverse_default = _bool(data.get("make_reverse_default"), False) or _bool(data.get("make_reverse_prompt_default"), False)
            if make_default or not _clean(config.data.get("default_image_provider_id")):
                config.update({"default_image_provider_id": provider["id"]})
            if provider.get("capabilities", {}).get("reverse_prompt") and (make_reverse_default or not _clean(config.data.get("default_reverse_image_provider_id"))):
                config.update({"default_reverse_image_provider_id": provider["id"]})
            self._save()
            return _public_provider(provider)

    def delete_provider(self, provider_id: str) -> bool:
        with self._lock:
            provider_id = _clean(provider_id)
            before = len(self._providers)
            self._providers = [item for item in self._providers if item.get("id") != provider_id]
            changed = len(self._providers) != before
            if changed:
                if _clean(config.data.get("default_image_provider_id")) == provider_id:
                    next_default = next((item for item in self._providers if item.get("enabled")), None)
                    config.update({"default_image_provider_id": next_default.get("id") if next_default else ""})
                if _clean(config.data.get("default_reverse_image_provider_id")) == provider_id:
                    next_reverse_default = next((item for item in self._providers if item.get("enabled") and item.get("capabilities", {}).get("reverse_prompt")), None)
                    config.update({"default_reverse_image_provider_id": next_reverse_default.get("id") if next_reverse_default else ""})
                self._save()
            return changed

    def set_default_provider(self, provider_id: str, *, purpose: str = "generate") -> dict[str, Any]:
        with self._lock:
            provider = self.get_provider(provider_id, require_enabled=False)
            if _clean(purpose).lower() in {"reverse", "reverse_prompt", "reverse-prompt"}:
                capabilities = provider.get("capabilities") if isinstance(provider.get("capabilities"), dict) else {}
                provider["capabilities"] = {
                    **capabilities,
                    "edit": True,
                    "reverse_prompt": True,
                }
                config.update({"default_reverse_image_provider_id": provider["id"]})
                self._save()
            else:
                config.update({"default_image_provider_id": provider["id"]})
            return _public_provider(provider)

    def get_default_provider(self, *, required: bool = True) -> dict[str, Any] | None:
        default_id = _clean(config.data.get("default_image_provider_id"))
        if default_id:
            try:
                return self.get_provider(default_id)
            except ValueError:
                pass
        provider = next((item for item in self._providers if item.get("enabled")), None)
        if provider:
            return provider
        if required:
            raise ValueError("No enabled image provider. Add one in settings.")
        return None

    def get_default_reverse_prompt_provider(self, *, required: bool = True) -> dict[str, Any] | None:
        default_id = _clean(config.data.get("default_reverse_image_provider_id"))
        if default_id:
            try:
                return self.get_provider(default_id)
            except ValueError:
                pass
        provider = next((item for item in self._providers if item.get("enabled") and item.get("capabilities", {}).get("reverse_prompt")), None)
        if provider:
            return provider
        if required:
            raise ValueError("No enabled reverse prompt provider. Add one in settings.")
        return None

    def get_provider(self, provider_id: str, *, require_enabled: bool = True) -> dict[str, Any]:
        provider_id = _clean(provider_id)
        provider = next((item for item in self._providers if item.get("id") == provider_id), None)
        if not provider:
            raise ValueError("Image provider not found.")
        if require_enabled and not provider.get("enabled"):
            raise ValueError("Image provider is disabled.")
        return provider

    def get_provider_api_key(self, provider_id: str) -> str:
        return _clean(self.get_provider(provider_id, require_enabled=False).get("api_key"))

    def resolve_provider(self, provider_id: str = "", *, purpose: str = "generate") -> dict[str, Any]:
        if _clean(provider_id):
            return self.get_provider(provider_id)
        if _clean(purpose).lower() in {"reverse", "reverse_prompt", "reverse-prompt"}:
            return self.get_default_reverse_prompt_provider()
        return self.get_default_provider()

    def test_provider(self, provider_id: str, *, model: str = "") -> dict[str, Any]:
        provider = self.get_provider(provider_id, require_enabled=False)
        started = time.time()
        url = f"{provider['base_url']}/models"
        response = requests.get(url, headers=self._headers(provider), timeout=provider["timeout_secs"])
        latency_ms = int((time.time() - started) * 1000)
        error = None if response.status_code < 400 else _extract_response_error(response)
        warnings = _provider_warnings(provider)
        selected_model = _clean(model)
        if response.status_code < 400 and selected_model:
            models = _models_from_response(response.json())
            if models and selected_model not in models:
                error = f"模型 {selected_model} 不在当前服务返回的模型列表中。"
            elif not models:
                warnings.append("连接可用，但上游没有返回可检查的模型列表。")
        return {
            "ok": response.status_code < 400 and not error,
            "status": response.status_code,
            "latency_ms": latency_ms,
            "error": error,
            "warnings": warnings,
        }

    def list_models(self, provider_id: str) -> dict[str, Any]:
        provider = self.get_provider(provider_id, require_enabled=False)
        started = time.time()
        response = requests.get(f"{provider['base_url']}/models", headers=self._headers(provider), timeout=provider["timeout_secs"])
        latency_ms = int((time.time() - started) * 1000)
        if response.status_code >= 400:
            error = _extract_response_error(response)
            self.record_provider_result(provider_id, ok=False, latency_ms=latency_ms, error=error)
            raise RuntimeError(error)
        data = response.json()
        models = _models_from_response(data)
        with self._lock:
            stored = self.get_provider(provider_id, require_enabled=False)
            stored["model_cache"] = models
            stored["model_cache_updated_at"] = str(_now_ms())
            stored["latency_ms"] = latency_ms
            self._save()
        return {"items": models}

    def record_provider_result(self, provider_id: str, *, ok: bool, latency_ms: int = 0, error: str = "") -> None:
        provider_id = _clean(provider_id)
        if not provider_id:
            return
        with self._lock:
            provider = next((item for item in self._providers if item.get("id") == provider_id), None)
            if not provider:
                return
            now = str(_now_ms())
            provider["latency_ms"] = max(0, int(latency_ms or 0))
            if ok:
                provider["last_success_at"] = now
                provider["last_error"] = ""
                provider["success_count"] = int(provider.get("success_count") or 0) + 1
            else:
                provider["last_error_at"] = now
                provider["last_error"] = _clean(error)[:500]
                provider["error_count"] = int(provider.get("error_count") or 0) + 1
            provider["updated_at"] = now
            self._save()

    def generate(self, request: ProviderRequest) -> dict[str, Any]:
        provider = self.get_provider(request.provider_id)
        if not provider["capabilities"].get("generate"):
            raise RuntimeError("Provider does not support image generation.")
        body = {
            "model": request.model or provider["default_model"],
            "prompt": request.prompt,
            "n": request.n,
            "response_format": request.response_format,
        }
        if request.size:
            body["size"] = request.size
        if request.quality:
            body["quality"] = request.quality
        return self._post_json(provider, "/images/generations", body)

    def edit(self, request: ProviderRequest) -> dict[str, Any]:
        provider = self.get_provider(request.provider_id)
        if request.images and not provider["capabilities"].get("edit"):
            raise RuntimeError("Provider does not support image edits.")
        body = {
            "model": request.model or provider["default_model"],
            "prompt": request.prompt,
            "n": request.n,
            "response_format": request.response_format,
        }
        if request.size:
            body["size"] = request.size
        if request.quality:
            body["quality"] = request.quality
        if not request.images:
            result = self._post_json(provider, "/images/edits", body)
        else:
            files = [
                ("image", (filename or f"image_{index}.png", image_data, mime_type or "image/png"))
                for index, (image_data, filename, mime_type) in enumerate(request.images, start=1)
            ]
            form_data = {key: str(value) for key, value in body.items() if value is not None and value != ""}
            result = self._post_multipart(provider, "/images/edits", form_data, files)
        if not request.message_as_error and not result.get("message") and not result.get("data"):
            result["message"] = ""
        return result

    def reverse_prompt(self, request: ProviderRequest) -> dict[str, Any]:
        provider = self.get_provider(request.provider_id)
        if not provider["capabilities"].get("reverse_prompt"):
            raise RuntimeError("Provider does not support reverse prompt.")
        if not request.model:
            request = ProviderRequest(
                provider_id=request.provider_id,
                prompt=request.prompt,
                model=_clean(provider.get("default_reverse_prompt_model"), provider["default_model"]),
                size=request.size,
                quality=request.quality,
                n=request.n,
                response_format=request.response_format,
                images=request.images,
                message_as_error=request.message_as_error,
                owner_id=request.owner_id,
            )
        return self.edit(request)

    def _headers(self, provider: dict[str, Any]) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        api_key = _clean(provider.get("api_key"))
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def _post_json(self, provider: dict[str, Any], path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = requests.post(
            f"{provider['base_url']}{path}",
            json=body,
            headers={**self._headers(provider), "Content-Type": "application/json"},
            timeout=provider["timeout_secs"],
        )
        if response.status_code >= 400:
            raise _provider_http_error(response, path)
        return _normalize_result(response.json())

    def _post_multipart(self, provider: dict[str, Any], path: str, data: dict[str, str], files: list[tuple[str, tuple[str, bytes, str]]]) -> dict[str, Any]:
        response = requests.post(
            f"{provider['base_url']}{path}",
            data=data,
            files=files,
            headers=self._headers(provider),
            timeout=provider["timeout_secs"],
        )
        if response.status_code >= 400:
            raise _provider_http_error(response, path)
        return _normalize_result(response.json())


def decode_provider_image_source(source: object) -> tuple[bytes, str, str] | None:
    decoded = decode_image_source(source)
    if not decoded:
        return None
    image_data, mime_type = decoded
    return image_data, "image.png", mime_type


image_provider_service = ImageProviderService(DATA_DIR / "image_providers.json")
