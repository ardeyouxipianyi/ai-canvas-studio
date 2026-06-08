from __future__ import annotations

import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.image_tasks as image_tasks_module


AUTH_HEADERS = {"Authorization": "Bearer ai-canvas-studio"}
AUTH_IDENTITY = {"id": "admin", "name": "Admin", "role": "admin"}


async def allow_filter_or_log(_call, _text):
    return None


class FakeImageTaskService:
    def __init__(self):
        self.generation_calls = []
        self.edit_calls = []
        self.reverse_prompt_calls = []
        self.cancel_calls = []

    def submit_generation(self, identity, **kwargs):
        self.generation_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "success",
            "mode": "generate",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
            "data": [{"url": f"{kwargs['base_url']}/images/fake.png"}],
        }

    def submit_edit(self, identity, **kwargs):
        self.edit_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "edit",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def submit_reverse_prompt(self, identity, **kwargs):
        self.reverse_prompt_calls.append((identity, kwargs))
        return {
            "id": kwargs["client_task_id"],
            "status": "queued",
            "mode": "reverse_prompt",
            "created_at": "2026-01-01 00:00:00",
            "updated_at": "2026-01-01 00:00:00",
        }

    def list_tasks(self, _identity, ids):
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "success",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "data": [{"url": "http://testserver/images/fake.png"}],
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }

    def cancel_tasks(self, identity, ids):
        self.cancel_calls.append((identity, ids))
        return {
            "items": [
                {
                    "id": task_id,
                    "status": "cancelled",
                    "mode": "generate",
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:01",
                    "error": "任务已取消",
                }
                for task_id in ids
                if task_id != "missing"
            ],
            "cancelled_ids": [task_id for task_id in ids if task_id != "missing"],
            "missing_ids": [task_id for task_id in ids if task_id == "missing"],
        }


class ImageTasksApiTests(unittest.TestCase):
    def setUp(self):
        self.fake_service = FakeImageTaskService()
        self.service_patcher = mock.patch.object(image_tasks_module, "image_task_service", self.fake_service)
        self.identity_patcher = mock.patch.object(image_tasks_module, "require_identity", return_value=AUTH_IDENTITY)
        self.filter_patcher = mock.patch.object(image_tasks_module, "filter_or_log", new=allow_filter_or_log)
        self.service_patcher.start()
        self.identity_patcher.start()
        self.filter_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.addCleanup(self.identity_patcher.stop)
        self.addCleanup(self.filter_patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def test_create_generation_task(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-1", "prompt": "cat", "model": "gpt-image-2"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["id"], "task-1")
        self.assertEqual(payload["status"], "success")
        self.assertEqual(len(self.fake_service.generation_calls), 1)
        self.assertEqual(self.fake_service.generation_calls[0][1]["provider_id"], "")

    def test_create_generation_task_passes_provider_id(self):
        response = self.client.post(
            "/api/image-tasks/generations",
            headers=AUTH_HEADERS,
            json={"client_task_id": "task-provider", "prompt": "cat", "model": "gpt-image-2", "provider_id": "provider-1"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.fake_service.generation_calls[0][1]["provider_id"], "provider-1")

    def test_create_edit_task_accepts_multiple_images(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            data={"client_task_id": "edit-1", "prompt": "edit", "model": "gpt-image-2"},
            files=[
                ("image", ("one.png", b"one", "image/png")),
                ("image", ("two.png", b"two", "image/png")),
            ],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-1")
        self.assertEqual(len(self.fake_service.edit_calls), 1)
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)

    def test_create_edit_task_accepts_json_image_source(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "edit-json",
                "prompt": "edit",
                "model": "gpt-image-2",
                "image": "data:image/png;base64,b25l",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-json")
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0][0], b"one")
        self.assertEqual(images[0][2], "image/png")

    def test_create_edit_task_accepts_json_image_sources(self):
        response = self.client.post(
            "/api/image-tasks/edits",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "edit-json-list",
                "prompt": "edit",
                "model": "gpt-image-2",
                "images": [
                    {"data": "data:image/png;base64,b25l", "filename": "one.png"},
                    {"data": "data:image/png;base64,dHdv", "filename": "two.png"},
                ],
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "edit-json-list")
        images = self.fake_service.edit_calls[0][1]["images"]
        self.assertEqual(len(images), 2)
        self.assertEqual(images[0][0], b"one")
        self.assertEqual(images[0][1], "one.png")
        self.assertEqual(images[1][0], b"two")
        self.assertEqual(images[1][1], "two.png")

    def test_create_reverse_prompt_task_accepts_json_image_source(self):
        response = self.client.post(
            "/api/image-tasks/reverse-prompts",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "reverse-json",
                "prompt": "describe this image",
                "model": "gpt-image-2",
                "image": {"data": "data:image/png;base64,b25l", "filename": "input.png"},
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["id"], "reverse-json")
        self.assertEqual(response.json()["mode"], "reverse_prompt")
        self.assertEqual(len(self.fake_service.reverse_prompt_calls), 1)
        images = self.fake_service.reverse_prompt_calls[0][1]["images"]
        self.assertEqual(images[0][0], b"one")
        self.assertEqual(images[0][1], "input.png")
        self.assertEqual(images[0][2], "image/png")

    def test_list_tasks_reports_missing_ids(self):
        response = self.client.get("/api/image-tasks?ids=task-1,missing", headers=AUTH_HEADERS)

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual([item["id"] for item in payload["items"]], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])

    def test_task_events_streams_task_payload_and_done(self):
        with self.client.stream(
            "GET",
            "/api/image-tasks/events?ids=task-1,missing&token=ai-canvas-studio",
        ) as response:
            self.assertEqual(response.status_code, 200)
            body = "".join(response.iter_text())

        self.assertIn("event: tasks", body)
        self.assertIn("event: done", body)
        self.assertIn('"missing_ids":["missing"]', body)

    def test_cancel_tasks(self):
        response = self.client.post(
            "/api/image-tasks/cancel",
            headers=AUTH_HEADERS,
            json={"ids": ["task-1", "missing"]},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["cancelled_ids"], ["task-1"])
        self.assertEqual(payload["missing_ids"], ["missing"])
        self.assertEqual(payload["items"][0]["status"], "cancelled")
        self.assertEqual(self.fake_service.cancel_calls[0][1], ["task-1", "missing"])


if __name__ == "__main__":
    unittest.main()
