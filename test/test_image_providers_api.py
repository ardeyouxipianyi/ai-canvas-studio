from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.providers as providers_module


AUTH_HEADERS = {"Authorization": "Bearer ai-canvas-studio"}
AUTH_IDENTITY = {"id": "admin", "name": "Admin", "role": "admin"}


class FakeImageProviderService:
    def __init__(self):
        self.items = [
            {
                "id": "provider-1",
                "name": "Provider One",
                "enabled": True,
                "capabilities": {"generate": True, "edit": True, "reverse_prompt": False},
            }
        ]
        self.default_provider_id = "provider-1"
        self.default_reverse_provider_id = ""

    def list_providers(self):
        return {
            "items": self.items,
            "default_provider_id": self.default_provider_id,
            "default_reverse_provider_id": self.default_reverse_provider_id,
        }

    def set_default_provider(self, provider_id: str, *, purpose: str = "generate"):
        if purpose == "reverse_prompt":
            self.default_reverse_provider_id = provider_id
            self.items[0]["capabilities"]["reverse_prompt"] = True
        else:
            self.default_provider_id = provider_id
        return self.items[0]

    def get_provider_api_key(self, provider_id: str):
        if provider_id != "provider-1":
            raise ValueError("Image provider not found.")
        return "sk-secret"


class ImageProvidersApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageProviderService()
        self.service_patcher = mock.patch.object(providers_module, "image_provider_service", self.fake_service)
        self.identity_patcher = mock.patch.object(providers_module, "require_identity", return_value=AUTH_IDENTITY)
        self.admin_patcher = mock.patch.object(providers_module, "require_admin", return_value=AUTH_IDENTITY)
        self.service_patcher.start()
        self.identity_patcher.start()
        self.admin_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.addCleanup(self.identity_patcher.stop)
        self.addCleanup(self.admin_patcher.stop)
        app = FastAPI()
        app.include_router(providers_module.create_router())
        self.client = TestClient(app)

    def test_set_reverse_default_returns_reverse_provider_id(self):
        response = self.client.post(
            "/api/image-providers/default",
            headers=AUTH_HEADERS,
            json={"provider_id": "provider-1", "purpose": "reverse_prompt"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["default_reverse_provider_id"], "provider-1")
        self.assertTrue(payload["items"][0]["capabilities"]["reverse_prompt"])

    def test_reveal_api_key_requires_admin_and_returns_secret(self):
        response = self.client.get("/api/image-providers/provider-1/api-key", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["api_key"], "sk-secret")


if __name__ == "__main__":
    unittest.main()
