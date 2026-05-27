from __future__ import annotations

import base64
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
import secrets
import sys
from pathlib import Path
import time

from services.storage.base import StorageBackend

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / "data"
PACKAGE_CONFIG_FILE = BASE_DIR / "config.json"
CONFIG_SEED_FILE = BASE_DIR / "config.seed.json"
CONFIG_EXAMPLE_FILE = BASE_DIR / "config.example.json"
VERSION_FILE = BASE_DIR / "VERSION"
BACKUP_STATE_FILE = DATA_DIR / "backup_state.json"
DEFAULT_ADMIN_AUTH_KEY = "chatgpt2api"
AUTH_KEY_HASH_FIELD = "auth-key-hash"
AUTH_KEY_HASH_ALGORITHM = "pbkdf2_sha256"
AUTH_KEY_HASH_ITERATIONS = 260_000


def _resolve_runtime_config_file() -> Path:
    raw = str(os.getenv("CHATGPT2API_CONFIG_FILE") or "").strip()
    if not raw:
        return DATA_DIR / "config.json"
    path = Path(raw).expanduser()
    return path if path.is_absolute() else BASE_DIR / path


CONFIG_FILE = _resolve_runtime_config_file()

DEFAULT_BACKUP_INCLUDE = {
    "config": True,
    "register": True,
    "cpa": True,
    "sub2api": True,
    "logs": True,
    "image_tasks": True,
    "image_conversations": True,
    "image_canvas": True,
    "accounts_snapshot": True,
    "auth_keys_snapshot": True,
    "images": False,
}
DEFAULT_REVERSE_PROMPT_INSTRUCTION = (
    "请根据这张图片反推出可用于 AI 画图的中文提示词。"
    "只输出一段可直接用于生图的提示词，尽量包含主体、构图、风格、光线、色彩、细节、镜头与氛围；"
    "不要解释过程，不要加入无关说明。"
)


def _normalize_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _normalize_positive_int(value: object, default: int, minimum: int = 0) -> int:
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        normalized = default
    return max(minimum, normalized)


def _normalize_backup_include(value: object) -> dict[str, bool]:
    source = value if isinstance(value, dict) else {}
    normalized = dict(DEFAULT_BACKUP_INCLUDE)
    for key in normalized:
        normalized[key] = _normalize_bool(source.get(key), normalized[key])
    return normalized


def _normalize_backup_settings(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    return {
        "enabled": _normalize_bool(source.get("enabled"), False),
        "provider": "cloudflare_r2",
        "account_id": str(source.get("account_id") or "").strip(),
        "access_key_id": str(source.get("access_key_id") or "").strip(),
        "secret_access_key": str(source.get("secret_access_key") or "").strip(),
        "bucket": str(source.get("bucket") or "").strip(),
        "prefix": str(source.get("prefix") or "backups").strip().strip("/") or "backups",
        "interval_minutes": _normalize_positive_int(source.get("interval_minutes"), 360, 1),
        "rotation_keep": _normalize_positive_int(source.get("rotation_keep"), 10, 0),
        "encrypt": _normalize_bool(source.get("encrypt"), False),
        "passphrase": str(source.get("passphrase") or "").strip(),
        "include": _normalize_backup_include(source.get("include")),
    }


def _normalize_backup_state(value: object) -> dict[str, object]:
    source = value if isinstance(value, dict) else {}
    return {
        "last_started_at": str(source.get("last_started_at") or "").strip() or None,
        "last_finished_at": str(source.get("last_finished_at") or "").strip() or None,
        "last_status": str(source.get("last_status") or "idle").strip() or "idle",
        "last_error": str(source.get("last_error") or "").strip() or None,
        "last_object_key": str(source.get("last_object_key") or "").strip() or None,
    }


@dataclass(frozen=True)
class LoadedSettings:
    auth_key: str
    refresh_account_interval_minute: int


def _normalize_auth_key(value: object) -> str:
    return str(value or "").strip()


def _normalize_auth_key_hash(value: object) -> str:
    return str(value or "").strip()


def _is_invalid_auth_key(value: object) -> bool:
    return _normalize_auth_key(value) == ""


def _hash_admin_auth_key(value: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", value.encode("utf-8"), salt, AUTH_KEY_HASH_ITERATIONS)
    encoded_salt = base64.urlsafe_b64encode(salt).decode("ascii").rstrip("=")
    encoded_digest = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
    return f"{AUTH_KEY_HASH_ALGORITHM}${AUTH_KEY_HASH_ITERATIONS}${encoded_salt}${encoded_digest}"


def _decode_unpadded_base64(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _verify_admin_auth_key_hash(raw_key: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, encoded_salt, encoded_digest = stored_hash.split("$", 3)
        if algorithm != AUTH_KEY_HASH_ALGORITHM:
            return False
        iteration_count = int(iterations)
        salt = _decode_unpadded_base64(encoded_salt)
        expected = _decode_unpadded_base64(encoded_digest)
        actual = hashlib.pbkdf2_hmac("sha256", raw_key.encode("utf-8"), salt, iteration_count)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _auth_key_requires_first_setup(value: object) -> bool:
    auth_key = _normalize_auth_key(value)
    return not auth_key or hmac.compare_digest(auth_key, DEFAULT_ADMIN_AUTH_KEY)


def _normalize_setup_required(raw_config: dict[str, object], auth_key: str | None = None) -> bool:
    if _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY")):
        return False
    candidate = _normalize_auth_key(auth_key if auth_key is not None else raw_config.get("auth-key"))
    stored_hash = _normalize_auth_key_hash(raw_config.get(AUTH_KEY_HASH_FIELD))
    return _normalize_bool(raw_config.get("setup_required"), False) or (not stored_hash and _auth_key_requires_first_setup(candidate))


def _prepare_first_run_config(raw_config: dict[str, object]) -> dict[str, object]:
    next_config = dict(raw_config)
    if not _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY")) and _auth_key_requires_first_setup(next_config.get("auth-key")):
        next_config["auth-key"] = ""
        next_config["setup_required"] = True
    return next_config


def _read_json_object(path: Path, *, name: str) -> dict[str, object]:
    if not path.exists():
        return {}
    if path.is_dir():
        print(
            f"Warning: {name} at '{path}' is a directory, ignoring it and falling back to other configuration sources.",
            file=sys.stderr,
        )
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.resolve() == right.resolve()
    except Exception:
        return left.absolute() == right.absolute()


def _seed_config_candidates(path: Path) -> list[Path]:
    candidates: list[Path] = []
    for candidate in (CONFIG_SEED_FILE, PACKAGE_CONFIG_FILE, CONFIG_EXAMPLE_FILE):
        if _same_path(candidate, path):
            continue
        if candidate not in candidates:
            candidates.append(candidate)
    return candidates


def _ensure_runtime_config(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return
    for candidate in _seed_config_candidates(path):
        if candidate.exists() and candidate.is_file():
            raw_config = _read_json_object(candidate, name=str(candidate))
            if raw_config:
                prepared = _prepare_first_run_config(raw_config)
                path.write_text(json.dumps(prepared, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            else:
                path.write_bytes(candidate.read_bytes())
            return
    path.write_text(
        json.dumps({"auth-key": "", "setup_required": True}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _load_settings() -> LoadedSettings:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _ensure_runtime_config(CONFIG_FILE)
    raw_config = _read_json_object(CONFIG_FILE, name="config.json")
    auth_key = _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or raw_config.get("auth-key"))
    stored_hash = _normalize_auth_key_hash(raw_config.get(AUTH_KEY_HASH_FIELD))
    if _is_invalid_auth_key(auth_key) and not stored_hash and not _normalize_setup_required(raw_config, auth_key):
        raise ValueError(
            "❌ auth-key 未设置！\n"
            "请在环境变量 CHATGPT2API_AUTH_KEY 中设置，或者在 config.json 中填写 auth-key。"
        )

    try:
        refresh_interval = int(raw_config.get("refresh_account_interval_minute", 5))
    except (TypeError, ValueError):
        refresh_interval = 5

    return LoadedSettings(
        auth_key=auth_key,
        refresh_account_interval_minute=refresh_interval,
    )


class ConfigStore:
    def __init__(self, path: Path):
        self.path = path
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _ensure_runtime_config(self.path)
        self.data = self._load()
        self._migrate_plain_admin_auth_key()
        self._storage_backend: StorageBackend | None = None
        if _is_invalid_auth_key(self.auth_key) and not _normalize_auth_key_hash(self.data.get(AUTH_KEY_HASH_FIELD)) and not self.setup_required:
            raise ValueError(
                "❌ auth-key 未设置！\n"
                "请按以下任意一种方式解决：\n"
                "1. 在 Render 的 Environment 变量中添加：\n"
                "   CHATGPT2API_AUTH_KEY = your_real_auth_key\n"
                "2. 或者在 config.json 中填写：\n"
                '   "auth-key": "your_real_auth_key"'
            )

    def _load(self) -> dict[str, object]:
        return _read_json_object(self.path, name="config.json")

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _migrate_plain_admin_auth_key(self) -> None:
        if self.auth_key_from_env:
            return
        plain_key = _normalize_auth_key(self.data.get("auth-key"))
        if not plain_key or _auth_key_requires_first_setup(plain_key):
            return
        if _normalize_auth_key_hash(self.data.get(AUTH_KEY_HASH_FIELD)):
            next_data = dict(self.data)
            next_data.pop("auth-key", None)
            self.data = next_data
            self._save()
            return
        next_data = dict(self.data)
        next_data[AUTH_KEY_HASH_FIELD] = _hash_admin_auth_key(plain_key)
        next_data["setup_required"] = False
        next_data.pop("auth-key", None)
        self.data = next_data
        self._save()

    @property
    def auth_key(self) -> str:
        return _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY") or self.data.get("auth-key"))

    def verify_admin_auth_key(self, raw_key: str) -> bool:
        candidate = _normalize_auth_key(raw_key)
        if not candidate:
            return False
        env_key = _normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY"))
        if env_key:
            return hmac.compare_digest(candidate, env_key)
        if self.setup_required:
            return False
        stored_hash = _normalize_auth_key_hash(self.data.get(AUTH_KEY_HASH_FIELD))
        if stored_hash:
            return _verify_admin_auth_key_hash(candidate, stored_hash)
        plain_key = _normalize_auth_key(self.data.get("auth-key"))
        return bool(plain_key) and hmac.compare_digest(candidate, plain_key)

    @property
    def auth_key_from_env(self) -> bool:
        return bool(_normalize_auth_key(os.getenv("CHATGPT2API_AUTH_KEY")))

    @property
    def admin_auth_key_editable(self) -> bool:
        return not self.auth_key_from_env

    @property
    def setup_required(self) -> bool:
        return _normalize_setup_required(self.data, self.auth_key)

    @property
    def accounts_file(self) -> Path:
        return DATA_DIR / "accounts.json"

    @property
    def refresh_account_interval_minute(self) -> int:
        try:
            return int(self.data.get("refresh_account_interval_minute", 5))
        except (TypeError, ValueError):
            return 5

    @property
    def image_retention_days(self) -> int:
        try:
            return max(1, int(self.data.get("image_retention_days", 30)))
        except (TypeError, ValueError):
            return 30

    @property
    def image_poll_timeout_secs(self) -> int:
        try:
            return max(1, int(self.data.get("image_poll_timeout_secs", 120)))
        except (TypeError, ValueError):
            return 120

    @property
    def image_unaccepted_task_timeout_secs(self) -> int:
        try:
            return max(1, int(self.data.get("image_unaccepted_task_timeout_secs", 20)))
        except (TypeError, ValueError):
            return 20

    @property
    def image_stalled_result_timeout_secs(self) -> int:
        try:
            return max(1, int(self.data.get("image_stalled_result_timeout_secs", 60)))
        except (TypeError, ValueError):
            return 60

    @property
    def image_account_concurrency(self) -> int:
        try:
            return max(1, int(self.data.get("image_account_concurrency", 3)))
        except (TypeError, ValueError):
            return 3

    @property
    def image_pool_failover_enabled(self) -> bool:
        value = self.data.get("image_pool_failover_enabled", True)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def image_pool_max_attempts(self) -> int:
        try:
            return max(1, int(self.data.get("image_pool_max_attempts", 3)))
        except (TypeError, ValueError):
            return 3

    @property
    def image_account_failure_cooldown_secs(self) -> int:
        try:
            return max(0, int(self.data.get("image_account_failure_cooldown_secs", 60)))
        except (TypeError, ValueError):
            return 60

    @property
    def image_empty_result_retry_enabled(self) -> bool:
        value = self.data.get("image_empty_result_retry_enabled", True)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def auto_remove_invalid_accounts(self) -> bool:
        value = self.data.get("auto_remove_invalid_accounts", False)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def auto_remove_rate_limited_accounts(self) -> bool:
        value = self.data.get("auto_remove_rate_limited_accounts", False)
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    @property
    def log_levels(self) -> list[str]:
        levels = self.data.get("log_levels")
        if not isinstance(levels, list):
            return []
        allowed = {"debug", "info", "warning", "error"}
        return [level for item in levels if (level := str(item or "").strip().lower()) in allowed]

    @property
    def sensitive_words(self) -> list[str]:
        words = self.data.get("sensitive_words")
        return [word for item in words if (word := str(item or "").strip())] if isinstance(words, list) else []

    @property
    def ai_review(self) -> dict[str, object]:
        value = self.data.get("ai_review")
        return value if isinstance(value, dict) else {}

    @property
    def global_system_prompt(self) -> str:
        return str(self.data.get("global_system_prompt") or "").strip()

    @property
    def reverse_prompt_instruction(self) -> str:
        return str(self.data.get("reverse_prompt_instruction") or DEFAULT_REVERSE_PROMPT_INSTRUCTION).strip() or DEFAULT_REVERSE_PROMPT_INSTRUCTION

    @property
    def images_dir(self) -> Path:
        path = DATA_DIR / "images"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def image_thumbnails_dir(self) -> Path:
        path = DATA_DIR / "image_thumbnails"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def cleanup_old_images(self) -> int:
        cutoff = time.time() - self.image_retention_days * 86400
        removed = 0
        for path in self.images_dir.rglob("*"):
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        for path in sorted((p for p in self.images_dir.rglob("*") if p.is_dir()), key=lambda p: len(p.parts), reverse=True):
            try:
                path.rmdir()
            except OSError:
                pass
        return removed

    @property
    def base_url(self) -> str:
        return str(
            os.getenv("CHATGPT2API_BASE_URL")
            or self.data.get("base_url")
            or ""
        ).strip().rstrip("/")

    @property
    def app_version(self) -> str:
        try:
            value = VERSION_FILE.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return "0.0.0"
        return value or "0.0.0"

    def get(self) -> dict[str, object]:
        data = dict(self.data)
        data["refresh_account_interval_minute"] = self.refresh_account_interval_minute
        data["image_retention_days"] = self.image_retention_days
        data["image_poll_timeout_secs"] = self.image_poll_timeout_secs
        data["image_unaccepted_task_timeout_secs"] = self.image_unaccepted_task_timeout_secs
        data["image_stalled_result_timeout_secs"] = self.image_stalled_result_timeout_secs
        data["image_account_concurrency"] = self.image_account_concurrency
        data["image_pool_failover_enabled"] = self.image_pool_failover_enabled
        data["image_pool_max_attempts"] = self.image_pool_max_attempts
        data["image_account_failure_cooldown_secs"] = self.image_account_failure_cooldown_secs
        data["image_empty_result_retry_enabled"] = self.image_empty_result_retry_enabled
        data["auto_remove_invalid_accounts"] = self.auto_remove_invalid_accounts
        data["auto_remove_rate_limited_accounts"] = self.auto_remove_rate_limited_accounts
        data["log_levels"] = self.log_levels
        data["sensitive_words"] = self.sensitive_words
        data["ai_review"] = self.ai_review
        data["global_system_prompt"] = self.global_system_prompt
        data["reverse_prompt_instruction"] = self.reverse_prompt_instruction
        data["admin_auth_key_editable"] = self.admin_auth_key_editable
        data["setup_required"] = self.setup_required
        data["backup"] = self.get_backup_settings()
        data.pop("auth-key", None)
        data.pop(AUTH_KEY_HASH_FIELD, None)
        return data

    def get_proxy_settings(self) -> str:
        return str(self.data.get("proxy") or "").strip()

    def update(self, data: dict[str, object]) -> dict[str, object]:
        updates = dict(data or {})
        updates.pop("auth-key", None)
        updates.pop(AUTH_KEY_HASH_FIELD, None)
        updates.pop("admin_auth_key_editable", None)
        updates.pop("setup_required", None)
        next_data = dict(self.data)
        next_data.update(updates)
        if "backup" in next_data:
            next_data["backup"] = _normalize_backup_settings(next_data.get("backup"))
        next_data.pop("backup_state", None)
        self.data = next_data
        self._save()
        return self.get()

    def update_admin_auth_key(self, current_key: str, new_key: str) -> dict[str, object]:
        if self.auth_key_from_env:
            raise ValueError("当前管理员密码由启动环境固定，不能在网页里修改")
        if self.setup_required:
            raise ValueError("请先完成首次部署的管理员密码设置")
        current = _normalize_auth_key(current_key)
        new_value = _normalize_auth_key(new_key)
        if not current:
            raise ValueError("请输入当前管理员密码")
        if not new_value:
            raise ValueError("请输入新的管理员密码")
        if len(new_value) < 6:
            raise ValueError("新的管理员密码至少需要 6 个字符")
        if not self.verify_admin_auth_key(current):
            raise ValueError("当前管理员密码不正确")
        if hmac.compare_digest(current, new_value):
            raise ValueError("新密码不能和当前密码相同")
        next_data = dict(self.data)
        next_data[AUTH_KEY_HASH_FIELD] = _hash_admin_auth_key(new_value)
        next_data["setup_required"] = False
        next_data.pop("auth-key", None)
        self.data = next_data
        self._save()
        return self.get()

    def initialize_admin_auth_key(self, new_key: str) -> dict[str, object]:
        if self.auth_key_from_env:
            raise ValueError("当前管理员密码由启动环境固定，不需要网页初始化")
        if not self.setup_required:
            raise ValueError("管理员密码已经设置完成")
        new_value = _normalize_auth_key(new_key)
        if not new_value:
            raise ValueError("请输入管理员密码")
        if len(new_value) < 6:
            raise ValueError("管理员密码至少需要 6 个字符")
        if hmac.compare_digest(new_value, DEFAULT_ADMIN_AUTH_KEY):
            raise ValueError("不能使用默认密码，请换一个新密码")
        next_data = dict(self.data)
        next_data[AUTH_KEY_HASH_FIELD] = _hash_admin_auth_key(new_value)
        next_data["setup_required"] = False
        next_data.pop("auth-key", None)
        self.data = next_data
        self._save()
        return self.get()

    def get_backup_settings(self) -> dict[str, object]:
        return _normalize_backup_settings(self.data.get("backup"))

    def get_storage_backend(self) -> StorageBackend:
        """获取存储后端实例（单例）"""
        if self._storage_backend is None:
            from services.storage.factory import create_storage_backend
            self._storage_backend = create_storage_backend(DATA_DIR)
        return self._storage_backend


def load_backup_state() -> dict[str, object]:
    return _normalize_backup_state(_read_json_object(BACKUP_STATE_FILE, name="backup_state.json"))


def save_backup_state(state: dict[str, object]) -> dict[str, object]:
    normalized = _normalize_backup_state(state)
    BACKUP_STATE_FILE.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return normalized


config = ConfigStore(CONFIG_FILE)
