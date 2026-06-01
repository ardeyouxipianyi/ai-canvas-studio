from __future__ import annotations

import os
import sys
import tempfile
import time
import types
import unittest
import uuid
from datetime import datetime
from pathlib import Path

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "test-auth")

fastapi_stub = types.ModuleType("fastapi")


class HTTPException(Exception):
    pass


fastapi_stub.HTTPException = HTTPException
concurrency_stub = types.ModuleType("fastapi.concurrency")
concurrency_stub.run_in_threadpool = lambda func, *args, **kwargs: func(*args, **kwargs)
responses_stub = types.ModuleType("fastapi.responses")
responses_stub.JSONResponse = object
responses_stub.StreamingResponse = object
helper_stub = types.ModuleType("utils.helper")
helper_stub.anthropic_sse_stream = lambda items: items
helper_stub.sse_json_stream = lambda items: items
helper_stub.anonymize_token = lambda token: "token:" + str(abs(hash(token)))[:8]
helper_stub.ensure_ok = lambda response, context: None
helper_stub.iter_sse_payloads = lambda response: iter(())
helper_stub.new_uuid = lambda: str(uuid.uuid4())
helper_stub.BASE_IMAGE_MODELS = {"gpt-image-2", "codex-gpt-image-2"}
helper_stub.IMAGE_MODEL_PLAN_TYPES = ("plus", "team", "pro")
helper_stub.CODEX_IMAGE_MODEL = "codex-gpt-image-2"
helper_stub.IMAGE_MODELS = {
    "gpt-image-2",
    "codex-gpt-image-2",
    "plus-codex-gpt-image-2",
    "team-codex-gpt-image-2",
    "pro-codex-gpt-image-2",
}


def _split_image_model(model):
    normalized = str(model or "").strip().lower()
    if normalized in helper_stub.BASE_IMAGE_MODELS:
        return None, normalized
    for plan_type in helper_stub.IMAGE_MODEL_PLAN_TYPES:
        prefix = f"{plan_type}-"
        if normalized.startswith(prefix) and normalized[len(prefix):] == helper_stub.CODEX_IMAGE_MODEL:
            return plan_type, helper_stub.CODEX_IMAGE_MODEL
    return None, None


helper_stub.split_image_model = _split_image_model
helper_stub.is_supported_image_model = lambda model: _split_image_model(model)[1] is not None
helper_stub.is_codex_image_model = lambda model: _split_image_model(model)[1] == helper_stub.CODEX_IMAGE_MODEL
helper_stub.extract_image_from_message_content = lambda content: []
helper_stub.build_chat_image_markdown_content = lambda result: "Image generation completed."
helper_stub.extract_chat_image = lambda body: []
helper_stub.extract_chat_prompt = lambda body: str(body.get("prompt") or "").strip() if isinstance(body, dict) else ""
helper_stub.is_image_chat_request = lambda body: isinstance(body, dict) and helper_stub.is_supported_image_model(body.get("model"))
helper_stub.parse_image_count = lambda value: max(1, min(4, int(value or 1)))
helper_stub.decode_image_source = lambda item: None
helper_stub.extract_response_prompt = lambda value: str(value or "").strip() if isinstance(value, str) else ""
helper_stub.has_response_image_generation_tool = lambda body: any(
    isinstance(tool, dict) and str(tool.get("type") or "").strip() == "image_generation"
    for tool in (body.get("tools") if isinstance(body, dict) and isinstance(body.get("tools"), list) else [])
)
try:
    import fastapi as _real_fastapi  # noqa: F401
    import fastapi.concurrency as _real_fastapi_concurrency  # noqa: F401
    import fastapi.responses as _real_fastapi_responses  # noqa: F401
    import utils.helper as _real_helper  # noqa: F401
except Exception:
    sys.modules.setdefault("fastapi", fastapi_stub)
    sys.modules.setdefault("fastapi.concurrency", concurrency_stub)
    sys.modules.setdefault("fastapi.responses", responses_stub)
    sys.modules.setdefault("utils.helper", helper_stub)

from services.account_service import AccountService
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend
from utils.helper import anonymize_token, split_image_model


def tearDownModule() -> None:
    if sys.modules.get("utils.helper") is helper_stub:
        sys.modules.pop("utils.helper", None)


class AccountCapabilityTests(unittest.TestCase):
    def test_unknown_quota_accounts_are_available_only_when_not_throttled(self) -> None:
        self.assertFalse(
            AccountService._is_image_account_available(
                {"status": "限流", "image_quota_unknown": True, "quota": 0}
            )
        )
        self.assertTrue(
            AccountService._is_image_account_available(
                {"status": "正常", "image_quota_unknown": True, "quota": 0}
            )
        )

    def test_prolite_variants_are_normalized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertEqual(service._normalize_account_type("prolite"), "ProLite")
            self.assertEqual(service._normalize_account_type("pro_lite"), "ProLite")

    def test_split_image_model_supports_plan_type_prefix(self) -> None:
        self.assertEqual(split_image_model("gpt-image-2"), (None, "gpt-image-2"))
        self.assertEqual(split_image_model("plus-codex-gpt-image-2"), ("plus", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("team-codex-gpt-image-2"), ("team", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("pro-codex-gpt-image-2"), ("pro", "codex-gpt-image-2"))
        self.assertEqual(split_image_model("plus-gpt-image-2"), (None, None))
        self.assertEqual(split_image_model("unknown-image-model"), (None, None))

    def test_get_available_access_token_filters_by_plan_and_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.replace_accounts([
                {"access_token": "web-plus", "type": "Plus", "source_type": "web", "status": "姝ｅ父", "quota": 2},
                {"access_token": "codex-team", "type": "Team", "source_type": "codex", "status": "姝ｅ父", "quota": 2},
                {"access_token": "codex-pro", "type": "Pro", "source_type": "codex", "status": "姝ｅ父", "quota": 2},
            ])
            service.fetch_remote_info = lambda token, _event="": service.get_account(token)  # type: ignore[method-assign]

            selected = service.get_available_access_token(plan_type="team", source_type="codex")

            self.assertEqual(selected, "codex-team")

    def test_codex_model_can_use_any_paid_codex_plan_when_unprefixed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.replace_accounts([
                {"access_token": "codex-free", "type": "free", "source_type": "codex", "status": "姝ｅ父", "quota": 2},
                {"access_token": "codex-plus", "type": "Plus", "source_type": "codex", "status": "姝ｅ父", "quota": 2},
            ])
            service.fetch_remote_info = lambda token, _event="": service.get_account(token)  # type: ignore[method-assign]

            selected = service.get_available_access_token(source_type="codex", plan_types=("plus", "team", "pro"))

            self.assertEqual(selected, "codex-plus")

    def test_search_account_type_ignores_unrelated_scalar_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            self.assertIsNone(
                service._search_account_type(
                    {
                        "amr": ["pwd", "otp", "mfa"],
                        "chatgpt_compute_residency": "no_constraint",
                        "chatgpt_data_residency": "no_constraint",
                        "user_id": "user-I52GFfLGFM0dokFk2dBiKEBn",
                    }
                )
            )

    def test_mark_image_result_does_not_consume_unknown_quota(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account(
                "token-1",
                {
                    "status": "正常",
                    "quota": 0,
                    "image_quota_unknown": True,
                },
            )

            updated = service.mark_image_result("token-1", success=True)

            self.assertIsNotNone(updated)
            self.assertEqual(updated["quota"], 0)
            self.assertEqual(updated["status"], "正常")
            self.assertTrue(updated["image_quota_unknown"])

    def test_image_cooldown_temporarily_excludes_failed_token(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1", "token-2"])
            service.update_account("token-1", {"status": "正常", "quota": 1})
            service.update_account("token-2", {"status": "正常", "quota": 1})

            service.cooldown_image_token("token-1", seconds=60)

            with service._lock:
                tokens = service._list_ready_candidate_tokens()

            self.assertEqual(tokens, ["token-2"])

    def test_image_token_selection_prefers_healthier_account(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["weak-token", "strong-token"])
            service.update_account(
                "weak-token",
                {
                    "status": "正常",
                    "quota": 1,
                    "success": 0,
                    "fail": 8,
                    "last_failed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            service.update_account(
                "strong-token",
                {
                    "status": "正常",
                    "quota": 5,
                    "success": 10,
                    "fail": 1,
                    "last_failed_at": "",
                },
            )
            service.fetch_remote_info = lambda token, _event="": service.get_account(token)  # type: ignore[method-assign]

            selected = service.get_available_access_token()

            self.assertEqual(selected, "strong-token")
            self.assertEqual(service._image_inflight.get("strong-token"), 1)
            self.assertTrue(service.get_account("strong-token")["last_selected_at"])

    def test_recently_refreshed_image_token_skips_remote_recheck(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account(
                "token-1",
                {
                    "status": "姝ｅ父",
                    "quota": 2,
                    "last_refreshed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                },
            )
            service.fetch_remote_info = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("should not recheck"))  # type: ignore[method-assign]

            selected = service.get_available_access_token()

            self.assertEqual(selected, "token-1")
            self.assertEqual(service._image_inflight.get("token-1"), 1)

    def test_failed_image_result_records_failure_reason_for_scoring(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1"])
            service.update_account("token-1", {"status": "正常", "quota": 2})

            updated = service.mark_image_result("token-1", success=False)

            self.assertIsNotNone(updated)
            self.assertEqual(updated["fail"], 1)
            self.assertTrue(updated["last_failed_at"])
            self.assertEqual(updated["last_failure_reason"], "image_generation_failed")

    def test_refresh_job_reports_progress_and_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AccountService(JSONStorageBackend(Path(tmp_dir) / "accounts.json"))
            service.add_accounts(["token-1", "token-2"])

            def fake_fetch(access_token: str, _event: str = "fetch_remote_info"):
                if access_token == "token-2":
                    raise RuntimeError("remote failed")
                return service.update_account(access_token, {"status": "正常", "quota": 2, "email": "a@example.com"})

            service.fetch_remote_info = fake_fetch  # type: ignore[method-assign]
            job = service.start_refresh_job(["token-1", "token-2"])

            deadline = time.time() + 2
            while job["status"] == "running" and time.time() < deadline:
                time.sleep(0.01)
                job = service.get_refresh_job(job["id"]) or job

            self.assertEqual(job["status"], "finished")
            self.assertEqual(job["total"], 2)
            self.assertEqual(job["done"], 2)
            self.assertEqual(job["refreshed"], 1)
            self.assertEqual(job["failed"], 1)
            self.assertEqual(len(job["errors"]), 1)
            self.assertEqual(len(job["items"]), 2)

    def test_refresh_accounts_batches_account_saves(self) -> None:
        class CountingStorage(JSONStorageBackend):
            def __init__(self, path: Path):
                super().__init__(path)
                self.save_count = 0

            def save_accounts(self, accounts):
                self.save_count += 1
                super().save_accounts(accounts)

        backend_module = types.ModuleType("services.openai_backend_api")

        class InvalidAccessTokenError(Exception):
            pass

        class OpenAIBackendAPI:
            def __init__(self, access_token: str):
                self.access_token = access_token

            def get_user_info(self):
                return {"status": "姝ｅ父", "quota": 3, "email": f"{self.access_token}@example.com"}

        backend_module.InvalidAccessTokenError = InvalidAccessTokenError
        backend_module.OpenAIBackendAPI = OpenAIBackendAPI

        previous_backend = sys.modules.get("services.openai_backend_api")
        sys.modules["services.openai_backend_api"] = backend_module
        try:
            with tempfile.TemporaryDirectory() as tmp_dir:
                storage = CountingStorage(Path(tmp_dir) / "accounts.json")
                service = AccountService(storage)
                service.add_accounts(["token-1", "token-2", "token-3"])
                storage.save_count = 0

                result = service.refresh_accounts(["token-1", "token-2", "token-3"])

                self.assertEqual(result["refreshed"], 3)
                self.assertEqual(storage.save_count, 1)
                self.assertEqual(service.get_account("token-1")["email"], "token-1@example.com")
        finally:
            if previous_backend is None:
                sys.modules.pop("services.openai_backend_api", None)
            else:
                sys.modules["services.openai_backend_api"] = previous_backend


class TokenLogTests(unittest.TestCase):
    def test_anonymize_token_hides_raw_value(self) -> None:
        token = "super-secret-token"
        token_ref = anonymize_token(token)

        self.assertTrue(token_ref.startswith("token:"))
        self.assertNotIn(token, token_ref)


class AuthServiceTests(unittest.TestCase):
    def test_create_authenticate_disable_and_delete_user_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))

            item, raw_key = service.create_key(role="user", name="Alice")

            self.assertEqual(item["role"], "user")
            self.assertEqual(item["name"], "Alice")
            self.assertTrue(item["enabled"])
            self.assertTrue(raw_key.startswith("sk-"))

            authed = service.authenticate(raw_key)
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertEqual(authed["role"], "user")
            self.assertIsNotNone(authed["last_used_at"])

            updated = service.update_key(item["id"], {"enabled": False}, role="user")
            self.assertIsNotNone(updated)
            self.assertFalse(updated["enabled"])
            self.assertIsNone(service.authenticate(raw_key))

            self.assertTrue(service.delete_key(item["id"], role="user"))
            self.assertFalse(service.delete_key(item["id"], role="user"))
            self.assertEqual(service.list_keys(role="user"), [])

    def test_authenticate_ignores_last_used_save_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            def fail_save() -> None:
                raise OSError("disk unavailable")

            service._save = fail_save

            authed = service.authenticate(raw_key)

            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])
            self.assertIsNotNone(authed["last_used_at"])

    def test_update_user_key_replaces_raw_key(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            item, raw_key = service.create_key(role="user", name="Alice")

            updated = service.update_key(item["id"], {"key": "sk-user-custom-key"}, role="user")

            self.assertIsNotNone(updated)
            self.assertIsNone(service.authenticate(raw_key))

            authed = service.authenticate("sk-user-custom-key")
            self.assertIsNotNone(authed)
            self.assertEqual(authed["id"], item["id"])

    def test_user_key_name_must_be_unique(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = AuthService(JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json"))
            first, _ = service.create_key(role="user", name="Alice")
            second, _ = service.create_key(role="user", name="Bob")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.create_key(role="user", name="Alice")

            with self.assertRaisesRegex(ValueError, "这个名称已经在使用中了"):
                service.update_key(second["id"], {"name": "Alice"}, role="user")

            updated = service.update_key(first["id"], {"name": "Alice"}, role="user")
            self.assertIsNotNone(updated)
            self.assertEqual(updated["name"], "Alice")


if __name__ == "__main__":
    unittest.main()
