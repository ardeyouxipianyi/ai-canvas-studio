import json
import tempfile
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
ROOT_CONFIG_FILE = ROOT_DIR / "config.json"


class ConfigLoadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._created_root_config = False
        if not ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.write_text(json.dumps({"auth-key": "test-auth"}), encoding="utf-8")
            cls._created_root_config = True

        from services import config as config_module

        cls.config_module = config_module

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._created_root_config and ROOT_CONFIG_FILE.exists():
            ROOT_CONFIG_FILE.unlink()

    def test_load_settings_ignores_directory_config_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            config_dir = base_dir / "config.json"
            os_auth_key = "env-auth"

            config_dir.mkdir()

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_config_file = module.CONFIG_FILE
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.CONFIG_FILE = config_dir
                module.os.environ["CHATGPT2API_AUTH_KEY"] = os_auth_key

                settings = module._load_settings()

                self.assertEqual(settings.auth_key, os_auth_key)
                self.assertEqual(settings.refresh_account_interval_minute, 5)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                module.CONFIG_FILE = old_config_file
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key

    def test_default_seed_requires_web_setup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            package_config = base_dir / "config.json"
            runtime_config = data_dir / "config.json"
            package_config.write_text(
                json.dumps({"auth-key": "chatgpt2api", "refresh_account_interval_minute": 11}),
                encoding="utf-8",
            )

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_package_config = module.PACKAGE_CONFIG_FILE
            old_seed_config = module.CONFIG_SEED_FILE
            old_example_config = module.CONFIG_EXAMPLE_FILE
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.PACKAGE_CONFIG_FILE = package_config
                module.CONFIG_SEED_FILE = base_dir / "missing-seed.json"
                module.CONFIG_EXAMPLE_FILE = base_dir / "missing-example.json"
                module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)

                store = module.ConfigStore(runtime_config)

                self.assertTrue(store.setup_required)
                self.assertEqual(store.auth_key, "")
                self.assertEqual(store.refresh_account_interval_minute, 11)
                persisted = json.loads(runtime_config.read_text(encoding="utf-8"))
                self.assertTrue(persisted["setup_required"])
                self.assertEqual(persisted["auth-key"], "")
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                module.PACKAGE_CONFIG_FILE = old_package_config
                module.CONFIG_SEED_FILE = old_seed_config
                module.CONFIG_EXAMPLE_FILE = old_example_config
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key

    def test_initialize_admin_auth_key_finishes_setup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            runtime_config = data_dir / "config.json"
            runtime_config.parent.mkdir(parents=True, exist_ok=True)
            runtime_config.write_text(
                json.dumps({"auth-key": "", "setup_required": True}),
                encoding="utf-8",
            )

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)

                store = module.ConfigStore(runtime_config)
                store.initialize_admin_auth_key("new-secret")

                self.assertFalse(store.setup_required)
                self.assertEqual(store.auth_key, "")
                self.assertTrue(store.verify_admin_auth_key("new-secret"))
                persisted = json.loads(runtime_config.read_text(encoding="utf-8"))
                self.assertFalse(persisted["setup_required"])
                self.assertNotIn("auth-key", persisted)
                self.assertIn("auth-key-hash", persisted)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key

    def test_plain_admin_auth_key_is_migrated_to_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            base_dir = Path(tmp_dir)
            data_dir = base_dir / "data"
            runtime_config = data_dir / "config.json"
            runtime_config.parent.mkdir(parents=True, exist_ok=True)
            runtime_config.write_text(
                json.dumps({"auth-key": "legacy-secret", "setup_required": False}),
                encoding="utf-8",
            )

            module = self.config_module
            old_base_dir = module.BASE_DIR
            old_data_dir = module.DATA_DIR
            old_env_auth_key = module.os.environ.get("CHATGPT2API_AUTH_KEY")
            try:
                module.BASE_DIR = base_dir
                module.DATA_DIR = data_dir
                module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)

                store = module.ConfigStore(runtime_config)

                self.assertFalse(store.setup_required)
                self.assertEqual(store.auth_key, "")
                self.assertTrue(store.verify_admin_auth_key("legacy-secret"))
                self.assertFalse(store.verify_admin_auth_key("wrong-secret"))
                persisted = json.loads(runtime_config.read_text(encoding="utf-8"))
                self.assertNotIn("auth-key", persisted)
                self.assertIn("auth-key-hash", persisted)
            finally:
                module.BASE_DIR = old_base_dir
                module.DATA_DIR = old_data_dir
                if old_env_auth_key is None:
                    module.os.environ.pop("CHATGPT2API_AUTH_KEY", None)
                else:
                    module.os.environ["CHATGPT2API_AUTH_KEY"] = old_env_auth_key


if __name__ == "__main__":
    unittest.main()
