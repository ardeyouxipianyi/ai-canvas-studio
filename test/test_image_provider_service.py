from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services import image_provider_service as provider_module
from services.image_provider_service import ImageProviderService, ProviderRequest


class FakeConfig:
    def __init__(self):
        self.data = {}

    def update(self, patch):
        self.data.update(patch)
        return self.data


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self.payload = payload or {}
        self.text = text

    def json(self):
        return self.payload


class ImageProviderServiceTests(unittest.TestCase):
    def make_service(self, tmp_dir: str):
        return ImageProviderService(Path(tmp_dir) / "image_providers.json")

    def test_save_provider_does_not_expose_api_key(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider(
                    {
                        "name": "Example",
                        "base_url": "https://api.example.com/v1/",
                        "api_key": "sk-secret",
                        "default_model": "gpt-image-1",
                    }
                )
                listed = service.list_providers()

        self.assertNotIn("api_key", item)
        self.assertTrue(item["has_api_key"])
        self.assertEqual(item["base_url"], "https://api.example.com/v1")
        self.assertEqual(listed["default_provider_id"], item["id"])
        self.assertNotIn("api_key", listed["items"][0])

    def test_save_provider_preserves_reverse_prompt_model(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider(
                    {
                        "name": "Example",
                        "base_url": "https://api.example.com/v1",
                        "api_key": "sk-secret",
                        "default_model": "gpt-image-generate",
                        "default_reverse_prompt_model": "gpt-image-reverse",
                    }
                )

        self.assertEqual(item["default_model"], "gpt-image-generate")
        self.assertEqual(item["default_reverse_prompt_model"], "gpt-image-reverse")

    def test_save_provider_rejects_api_key_url(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                with self.assertRaisesRegex(ValueError, "api_key"):
                    service.save_provider(
                        {
                            "name": "Bad",
                            "base_url": "https://api.example.com/v1",
                            "api_key": "https://api.example.com/v1",
                        }
                    )

    def test_public_provider_warns_when_base_url_misses_v1(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider(
                    {
                        "name": "Root",
                        "base_url": "https://api.example.com",
                        "api_key": "sk-secret",
                    }
                )

        self.assertTrue(item["warnings"])
        self.assertIn("/v1", item["warnings"][0])

    def test_generate_parses_url_result(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider({"base_url": "https://api.example.com/v1", "api_key": "sk-secret"})

            captured = {}

            def fake_post(url, json=None, headers=None, timeout=None, **_kwargs):
                captured.update({"url": url, "json": json, "headers": headers, "timeout": timeout})
                return FakeResponse(payload={"data": [{"url": "https://cdn.example.com/image.png"}], "usage": {"input_tokens": 12}})

            with mock.patch.object(provider_module.requests, "post", fake_post):
                result = service.generate(ProviderRequest(provider_id=item["id"], prompt="cat", model="gpt-image-1"))

        self.assertEqual(captured["url"], "https://api.example.com/v1/images/generations")
        self.assertEqual(captured["json"]["prompt"], "cat")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer sk-secret")
        self.assertEqual(result["data"][0]["url"], "https://cdn.example.com/image.png")
        self.assertEqual(result["usage"]["input_tokens"], 12)

    def test_generate_parses_b64_json_result(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider({"base_url": "https://api.example.com/v1", "api_key": "sk-secret"})

            with mock.patch.object(
                provider_module.requests,
                "post",
                lambda *_args, **_kwargs: FakeResponse(payload={"data": [{"b64_json": "ZmFrZQ=="}]}),
            ):
                result = service.generate(ProviderRequest(provider_id=item["id"], prompt="cat", model="gpt-image-1"))

        self.assertEqual(result["data"][0]["b64_json"], "ZmFrZQ==")

    def test_reverse_prompt_requires_capability(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider(
                    {
                        "base_url": "https://api.example.com/v1",
                        "api_key": "sk-secret",
                        "capabilities": {"generate": True, "edit": True, "reverse_prompt": False},
                    }
                )

            request = ProviderRequest(
                provider_id=item["id"],
                prompt="describe",
                model="gpt-image-1",
                images=[(b"image", "input.png", "image/png")],
                message_as_error=False,
            )
            with self.assertRaisesRegex(RuntimeError, "reverse prompt"):
                service.reverse_prompt(request)

    def test_reverse_prompt_posts_to_image_edits_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider(
                    {
                        "base_url": "https://api.example.com/v1",
                        "api_key": "sk-secret",
                        "capabilities": {"generate": True, "edit": True, "reverse_prompt": True},
                    }
                )

            captured = {}

            def fake_post(url, data=None, files=None, **_kwargs):
                captured.update({"url": url, "data": data, "files": files})
                return FakeResponse(payload={"data": [], "message": "cinematic prompt"})

            request = ProviderRequest(
                provider_id=item["id"],
                prompt="describe",
                model="gpt-image-1",
                images=[(b"image", "input.png", "image/png")],
                message_as_error=False,
            )
            with mock.patch.object(provider_module.requests, "post", fake_post):
                result = service.reverse_prompt(request)

        self.assertEqual(captured["url"], "https://api.example.com/v1/images/edits")
        self.assertEqual(captured["data"]["prompt"], "describe")
        self.assertEqual(result["message"], "cinematic prompt")

    def test_test_provider_returns_warnings(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider({"base_url": "https://api.example.com", "api_key": "sk-secret"})

            with mock.patch.object(
                provider_module.requests,
                "get",
                lambda *_args, **_kwargs: FakeResponse(payload={"data": [{"id": "gpt-image-1"}]}),
            ):
                result = service.test_provider(item["id"])

        self.assertTrue(result["ok"])
        self.assertTrue(result["warnings"])

    def test_list_models_persists_model_cache(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider({"base_url": "https://api.example.com/v1", "api_key": "sk-secret"})

            with mock.patch.object(
                provider_module.requests,
                "get",
                lambda *_args, **_kwargs: FakeResponse(payload={"data": [{"id": "gpt-image-1"}, {"id": "gpt-image-2"}]}),
            ):
                result = service.list_models(item["id"])
                listed = service.list_providers()

        self.assertEqual(result["items"], ["gpt-image-1", "gpt-image-2"])
        self.assertEqual(listed["items"][0]["model_cache"], ["gpt-image-1", "gpt-image-2"])
        self.assertTrue(listed["items"][0]["model_cache_updated_at"])

    def test_record_provider_result_updates_status_fields(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                item = service.save_provider({"base_url": "https://api.example.com/v1", "api_key": "sk-secret"})
                service.record_provider_result(item["id"], ok=True, latency_ms=123)
                service.record_provider_result(item["id"], ok=False, latency_ms=456, error="quota failed")
                listed = service.list_providers()["items"][0]

        self.assertEqual(listed["success_count"], 1)
        self.assertEqual(listed["error_count"], 1)
        self.assertEqual(listed["latency_ms"], 456)
        self.assertEqual(listed["last_error"], "quota failed")

    def test_generation_and_reverse_defaults_are_independent(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                generate_provider = service.save_provider(
                    {
                        "name": "Generate",
                        "base_url": "https://generate.example.com/v1",
                        "api_key": "sk-generate",
                        "capabilities": {"generate": True, "edit": True, "reverse_prompt": False},
                        "make_default": True,
                    }
                )
                reverse_provider = service.save_provider(
                    {
                        "name": "Reverse",
                        "base_url": "https://reverse.example.com/v1",
                        "api_key": "sk-reverse",
                        "capabilities": {"generate": False, "edit": True, "reverse_prompt": True},
                        "make_reverse_default": True,
                    }
                )
                listed = service.list_providers()

        self.assertEqual(listed["default_provider_id"], generate_provider["id"])
        self.assertEqual(listed["default_reverse_provider_id"], reverse_provider["id"])

    def test_set_reverse_default_enables_reverse_capability(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                provider = service.save_provider(
                    {
                        "name": "Generate",
                        "base_url": "https://generate.example.com/v1",
                        "api_key": "sk-generate",
                        "capabilities": {"generate": True, "edit": True, "reverse_prompt": False},
                    }
                )
                service.set_default_provider(provider["id"], purpose="reverse_prompt")
                listed = service.list_providers()

        item = listed["items"][0]
        self.assertEqual(listed["default_reverse_provider_id"], provider["id"])
        self.assertTrue(item["capabilities"]["reverse_prompt"])
        self.assertTrue(item["capabilities"]["edit"])
        self.assertEqual(fake_config.data["default_reverse_image_provider_id"], provider["id"])

    def test_missing_default_provider_is_clear(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            fake_config = FakeConfig()
            with mock.patch.object(provider_module, "config", fake_config):
                service = self.make_service(tmp_dir)
                with self.assertRaisesRegex(ValueError, "No enabled image provider"):
                    service.resolve_provider()


if __name__ == "__main__":
    unittest.main()
