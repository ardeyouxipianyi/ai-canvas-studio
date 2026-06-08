import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

from services import backup_service as backup_module
from services.backup_service import BackupService, REDACTED_VALUE


class FakeStorageBackend:
    def load_accounts(self):
        return [
            {
                "access_token": "account-secret-token",
                "email": "owner@example.com",
                "quota": 3,
            }
        ]

    def load_auth_keys(self):
        return [
            {
                "id": "user-1",
                "name": "User",
                "role": "user",
                "key_hash": "user-key-hash-secret",
                "enabled": True,
                "usage": {"total_calls": 2},
            }
        ]

    def get_backend_info(self):
        return {"type": "fake"}


class FakeConfig:
    app_version = "test-version"

    def __init__(self, data_dir: Path):
        self._data_dir = data_dir
        self._storage = FakeStorageBackend()
        self.data = {}

    @property
    def images_dir(self):
        path = self._data_dir / "images"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_storage_backend(self):
        return self._storage


def archive_members(payload: bytes) -> dict[str, bytes]:
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        return {
            str(member.name): archive.extractfile(member).read()
            for member in archive.getmembers()
            if member.isfile() and archive.extractfile(member) is not None
        }


def decode_json(members: dict[str, bytes], name: str):
    return json.loads(members[name].decode("utf-8"))


class BackupServiceSensitiveExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data_dir = self.root / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.data_dir / "config.json"
        self.tags_file = self.data_dir / "image_tags.json"

        self.config_file.write_text(
            json.dumps(
                {
                    "auth-key-hash": "admin-hash-secret",
                    "proxy": "http://proxy.example",
                    "ai_review": {"api_key": "ai-review-secret"},
                    "backup": {
                        "secret_access_key": "r2-secret-key",
                        "passphrase": "backup-passphrase",
                    },
                }
            ),
            encoding="utf-8",
        )
        (self.data_dir / "cpa_config.json").write_text(
            json.dumps({"pools": [{"secret_key": "cpa-secret"}]}),
            encoding="utf-8",
        )
        (self.data_dir / "logs.jsonl").write_text(
            json.dumps({"detail": {"error": "Authorization: Bearer very-secret-token"}}) + "\n",
            encoding="utf-8",
        )

        self.old_config = backup_module.config
        self.old_config_file = backup_module.CONFIG_FILE
        self.old_data_dir = backup_module.DATA_DIR
        self.old_tags_file = backup_module.TAGS_FILE
        backup_module.config = FakeConfig(self.data_dir)
        backup_module.CONFIG_FILE = self.config_file
        backup_module.DATA_DIR = self.data_dir
        backup_module.TAGS_FILE = self.tags_file

    def tearDown(self):
        backup_module.config = self.old_config
        backup_module.CONFIG_FILE = self.old_config_file
        backup_module.DATA_DIR = self.old_data_dir
        backup_module.TAGS_FILE = self.old_tags_file
        self.tmp.cleanup()

    def test_manual_export_redacts_sensitive_values_by_default(self):
        result = BackupService().export_data(
            {
                "config": True,
                "cpa": True,
                "logs": True,
                "accounts_snapshot": True,
                "auth_keys_snapshot": True,
            }
        )

        members = archive_members(result["payload"])
        metadata = decode_json(members, "backup-metadata.json")
        self.assertFalse(metadata["sensitive_included"])
        self.assertTrue(metadata["redacted"])

        raw_archive_text = b"\n".join(members.values()).decode("utf-8")
        for secret in (
            "admin-hash-secret",
            "ai-review-secret",
            "r2-secret-key",
            "backup-passphrase",
            "cpa-secret",
            "account-secret-token",
            "user-key-hash-secret",
            "very-secret-token",
        ):
            self.assertNotIn(secret, raw_archive_text)
        self.assertNotIn("data/cpa_config.json", members)
        self.assertNotIn("snapshots/accounts.json", members)

        config = decode_json(members, "config.json")
        self.assertEqual(config["auth-key-hash"], REDACTED_VALUE)
        self.assertEqual(config["ai_review"]["api_key"], REDACTED_VALUE)
        auth_keys = decode_json(members, "snapshots/auth_keys.json")
        self.assertEqual(auth_keys[0]["key_hash"], REDACTED_VALUE)

    def test_manual_export_can_include_sensitive_values_for_full_migration(self):
        result = BackupService().export_data(
            {
                "config": True,
                "cpa": True,
                "logs": True,
                "accounts_snapshot": True,
                "auth_keys_snapshot": True,
            },
            include_sensitive=True,
        )

        members = archive_members(result["payload"])
        metadata = decode_json(members, "backup-metadata.json")
        self.assertTrue(metadata["sensitive_included"])
        self.assertFalse(metadata["redacted"])

        raw_archive_text = b"\n".join(members.values()).decode("utf-8")
        self.assertIn("admin-hash-secret", raw_archive_text)
        self.assertIn("user-key-hash-secret", raw_archive_text)
        self.assertNotIn("account-secret-token", raw_archive_text)
        self.assertNotIn("data/cpa_config.json", members)
        self.assertNotIn("snapshots/accounts.json", members)


if __name__ == "__main__":
    unittest.main()
