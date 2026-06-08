import json
import tempfile
import unittest
from pathlib import Path

from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend


class AuthServiceUsageTests(unittest.TestCase):
    def test_user_key_usage_stats_are_recorded_and_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            storage = JSONStorageBackend(Path(tmp_dir) / "accounts.json", Path(tmp_dir) / "auth_keys.json")
            service = AuthService(storage)
            item, raw_key = service.create_key(role="user", name="tester")
            identity = service.authenticate(raw_key)

            self.assertIsNotNone(identity)
            service.record_usage(
                identity or {},
                endpoint="/api/image-tasks/generations",
                status="success",
                duration_ms=1200,
                generated_images=2,
            )
            service.record_usage(
                identity or {},
                endpoint="/api/settings",
                status="failed",
                duration_ms=800,
            )

            [saved] = service.list_keys(role="user")
            usage = saved["usage"]
            self.assertEqual(usage["total_calls"], 2)
            self.assertEqual(usage["successful_calls"], 1)
            self.assertEqual(usage["failed_calls"], 1)
            self.assertEqual(usage["image_calls"], 1)
            self.assertEqual(usage["image_successful_calls"], 1)
            self.assertEqual(usage["image_failed_calls"], 0)
            self.assertEqual(usage["generated_images"], 2)
            self.assertEqual(usage["total_duration_ms"], 2000)
            self.assertTrue(usage["last_call_at"])
            self.assertTrue(usage["last_success_at"])
            self.assertTrue(usage["last_failure_at"])

            persisted = json.loads((Path(tmp_dir) / "auth_keys.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["items"][0]["id"], item["id"])
            self.assertEqual(persisted["items"][0]["usage"]["total_calls"], 2)


if __name__ == "__main__":
    unittest.main()
