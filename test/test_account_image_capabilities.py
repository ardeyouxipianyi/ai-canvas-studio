from __future__ import annotations

import os
import sys
import tempfile
import time
import types
import unittest
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
sys.modules.setdefault("fastapi", fastapi_stub)
sys.modules.setdefault("fastapi.concurrency", concurrency_stub)
sys.modules.setdefault("fastapi.responses", responses_stub)
sys.modules.setdefault("utils.helper", helper_stub)

from services.account_service import AccountService
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend
from utils.helper import anonymize_token


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
