from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.auth_users as auth_users_module
from services.auth_service import AuthService
from services.storage.json_storage import JSONStorageBackend


AUTH_HEADERS = {"Authorization": "Bearer admin"}
AUTH_IDENTITY = {"id": "admin", "name": "Admin", "role": "admin"}


class AuthUsersApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        root = Path(self.tmp_dir.name)
        self.service = AuthService(JSONStorageBackend(root / "accounts.json", root / "auth_keys.json"))
        self.service_patcher = mock.patch.object(auth_users_module, "auth_service", self.service)
        self.identity_patcher = mock.patch.object(auth_users_module, "require_admin", return_value=AUTH_IDENTITY)
        self.service_patcher.start()
        self.identity_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.addCleanup(self.identity_patcher.stop)
        app = FastAPI()
        app.include_router(auth_users_module.create_router())
        self.client = TestClient(app)

    def test_user_key_lifecycle(self):
        list_response = self.client.get("/api/auth/users", headers=AUTH_HEADERS)
        self.assertEqual(list_response.status_code, 200, list_response.text)
        self.assertEqual(list_response.json()["items"], [])

        create_response = self.client.post("/api/auth/users", headers=AUTH_HEADERS, json={"name": "tester"})
        self.assertEqual(create_response.status_code, 200, create_response.text)
        created = create_response.json()["item"]
        self.assertEqual(created["name"], "tester")
        self.assertTrue(create_response.json()["key"].startswith("sk-"))

        update_response = self.client.post(
            f"/api/auth/users/{created['id']}",
            headers=AUTH_HEADERS,
            json={"enabled": False, "name": "tester-disabled"},
        )
        self.assertEqual(update_response.status_code, 200, update_response.text)
        updated = update_response.json()["item"]
        self.assertEqual(updated["name"], "tester-disabled")
        self.assertFalse(updated["enabled"])

        delete_response = self.client.delete(f"/api/auth/users/{created['id']}", headers=AUTH_HEADERS)
        self.assertEqual(delete_response.status_code, 200, delete_response.text)
        self.assertEqual(delete_response.json()["items"], [])

    def test_update_without_changes_returns_clear_error(self):
        response = self.client.post("/api/auth/users/missing", headers=AUTH_HEADERS, json={})
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("还没有检测到改动", response.text)


if __name__ == "__main__":
    unittest.main()
