from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from services import image_task_service as task_module
from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}


class FakeProviderService:
    def __init__(self, generation_handler=None, edit_handler=None, *, enabled: bool = True, reverse_prompt: bool = True, reverse_model: str = "gpt-image-reverse"):
        self.generation_handler = generation_handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]})
        self.edit_handler = edit_handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]})
        self.enabled = enabled
        self.supports_reverse_prompt = reverse_prompt
        self.reverse_model = reverse_model
        self.results = []

    def resolve_provider(self, provider_id: str = "", **_kwargs):
        if not self.enabled:
            raise ValueError("No enabled image provider. Add one in settings.")
        return {
            "id": provider_id or "provider-test",
            "name": "Test Provider",
            "type": "openai_compatible",
            "default_model": "gpt-image-2",
            "default_reverse_prompt_model": self.reverse_model,
            "default_size": "",
            "default_quality": "auto",
            "capabilities": {"generate": True, "edit": True, "reverse_prompt": self.supports_reverse_prompt},
        }

    def _payload(self, request):
        return {
            "prompt": request.prompt,
            "model": request.model,
            "size": request.size,
            "quality": request.quality,
            "n": request.n,
            "images": request.images or [],
            "message_as_error": request.message_as_error,
            "owner_id": request.owner_id,
        }

    def generate(self, request):
        return self.generation_handler(self._payload(request))

    def edit(self, request):
        return self.edit_handler(self._payload(request))

    def reverse_prompt(self, request):
        if not self.supports_reverse_prompt:
            raise RuntimeError("Provider does not support reverse prompt.")
        return self.edit_handler(self._payload(request))

    def record_provider_result(self, provider_id, *, ok, latency_ms=0, error=""):
        self.results.append({"provider_id": provider_id, "ok": ok, "latency_ms": latency_ms, "error": error})


def wait_for_task(service: ImageTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


def wait_for_task_stage(service: ImageTaskService, identity: dict[str, object], task_id: str, stage: str, timeout: float = 2.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("stage") == stage:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach stage {stage}, last={last}")


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None) -> ImageTaskService:
        provider_service = FakeProviderService(handler, handler)
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]}),
            retention_days_getter=lambda: 30,
            provider_service=provider_service,
            image_archiver=lambda data, _base_url, _owner_id: data,
        )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                time.sleep(0.05)
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            first = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            second = service.submit_generation(
                OWNER,
                client_task_id="task-1",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            task = wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(task["data"][0]["url"], "http://example.test/image.png")
            self.assertEqual(task["progress"], 100)
            self.assertEqual(task["progress_message"], "已完成")
            self.assertEqual(calls, 1)

    def test_submit_generation_passes_owner_id_to_handler(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            seen_owner_ids = []

            def handler(payload):
                seen_owner_ids.append(payload.get("owner_id"))
                return {"data": [{"url": "http://example.test/image.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="owner-payload-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "owner-payload-task", "success")

            self.assertEqual(seen_owner_ids, ["owner-1"])

    def test_success_task_archives_provider_image_outputs(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            seen_archive = []

            def handler(_payload):
                return {"data": [{"url": "http://remote.example/image.png", "revised_prompt": "cat"}]}

            def archiver(data, base_url, owner_id):
                seen_archive.append({"data": data, "base_url": base_url, "owner_id": owner_id})
                return [{**data[0], "url": f"{base_url}/images/users/{owner_id}/archived.png", "original_url": data[0]["url"]}]

            provider_service = FakeProviderService(handler, handler)
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                retention_days_getter=lambda: 30,
                provider_service=provider_service,
                image_archiver=archiver,
            )
            service.submit_generation(
                OWNER,
                client_task_id="archive-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            task = wait_for_task(service, OWNER, "archive-task", "success")

            self.assertEqual(seen_archive[0]["base_url"], "http://local.test")
            self.assertEqual(seen_archive[0]["owner_id"], "owner-1")
            self.assertEqual(task["data"][0]["url"], "http://local.test/images/users/owner-1/archived.png")
            self.assertEqual(task["data"][0]["original_url"], "http://remote.example/image.png")

    def test_archive_image_outputs_saves_b64_json_as_local_url(self):
        with mock.patch.object(task_module, "save_image_bytes", lambda image_data, base_url, owner_id: f"{base_url}/images/users/{owner_id}/saved.png") as _mock_save:
            data = task_module.archive_image_outputs([{"b64_json": "ZmFrZQ==", "revised_prompt": "cat"}], "http://local.test", "owner-1")

        self.assertEqual(data[0]["url"], "http://local.test/images/users/owner-1/saved.png")
        self.assertEqual(data[0]["revised_prompt"], "cat")
        self.assertNotIn("b64_json", data[0])

    def test_submit_generation_fails_without_enabled_provider(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                retention_days_getter=lambda: 30,
                provider_service=FakeProviderService(enabled=False),
            )
            with self.assertRaisesRegex(ValueError, "No enabled image provider"):
                service.submit_generation(
                    OWNER,
                    client_task_id="no-provider-task",
                    prompt="cat",
                    model="gpt-image-2",
                    size=None,
                    base_url="http://local.test",
                )

    def test_submit_reverse_prompt_persists_message_result(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            seen_payloads = []

            def handler(payload):
                seen_payloads.append(payload)
                return {"data": [], "message": "cinematic cat portrait prompt"}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_reverse_prompt(
                OWNER,
                client_task_id="reverse-task",
                prompt="describe this image",
                model="gpt-image-2",
                base_url="http://local.test",
                images=[(b"image", "input.png", "image/png")],
            )
            task = wait_for_task(service, OWNER, "reverse-task", "success")

            self.assertEqual(task["mode"], "reverse_prompt")
            self.assertEqual(task["message"], "cinematic cat portrait prompt")
            self.assertEqual(task["data"], [])
            self.assertFalse(seen_payloads[0]["message_as_error"])
            self.assertEqual(seen_payloads[0]["owner_id"], "owner-1")

    def test_submit_reverse_prompt_uses_reverse_default_model(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            seen_payloads = []

            def handler(payload):
                seen_payloads.append(payload)
                return {"data": [], "message": "cinematic cat portrait prompt"}

            provider_service = FakeProviderService(handler, handler, reverse_model="gpt-image-reverse")
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                retention_days_getter=lambda: 30,
                provider_service=provider_service,
                image_archiver=lambda data, _base_url, _owner_id: data,
            )
            service.submit_reverse_prompt(
                OWNER,
                client_task_id="reverse-default-model-task",
                prompt="describe this image",
                model="",
                base_url="http://local.test",
                images=[(b"image", "input.png", "image/png")],
            )
            task = wait_for_task(service, OWNER, "reverse-default-model-task", "success")

            self.assertEqual(task["model"], "gpt-image-reverse")
            self.assertEqual(seen_payloads[0]["model"], "gpt-image-reverse")

    def test_submit_reverse_prompt_requires_provider_capability(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                retention_days_getter=lambda: 30,
                provider_service=FakeProviderService(reverse_prompt=False),
            )

            with self.assertRaisesRegex(ValueError, "reverse prompt"):
                service.submit_reverse_prompt(
                    OWNER,
                    client_task_id="reverse-disabled-task",
                    prompt="describe this image",
                    model="gpt-image-2",
                    base_url="http://local.test",
                    images=[(b"image", "input.png", "image/png")],
                )

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="private-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_success_task_persists_to_new_service_instance(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            service = self.make_service(path)
            service.submit_generation(
                OWNER,
                client_task_id="persisted-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "persisted-task", "success")

            reloaded = self.make_service(path)
            result = reloaded.list_tasks(OWNER, ["persisted-task"])

            self.assertEqual(result["missing_ids"], [])
            self.assertEqual(result["items"][0]["status"], "success")
            self.assertEqual(result["items"][0]["data"][0]["url"], "http://example.test/image.png")

    def test_success_task_exposes_stage_duration_and_usage(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            provider_service = FakeProviderService(lambda _payload: {"data": [{"url": "http://example.test/image.png"}], "usage": {"input_tokens": 2}})
            service = ImageTaskService(
                Path(tmp_dir) / "image_tasks.json",
                retention_days_getter=lambda: 30,
                provider_service=provider_service,
                image_archiver=lambda data, _base_url, _owner_id: data,
            )
            service.submit_generation(
                OWNER,
                client_task_id="metadata-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "metadata-task", "success")
            task = wait_for_task_stage(service, OWNER, "metadata-task", "success")

            self.assertEqual(task["stage"], "success")
            self.assertGreaterEqual(task["duration_ms"], 0)
            self.assertEqual(task["usage"]["input_tokens"], 2)
            self.assertEqual(provider_service.results[-1]["ok"], True)

    def test_retryable_provider_error_retries_once(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise RuntimeError("network timeout")
                return {"data": [{"url": "http://example.test/retried.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="retry-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "retry-task", "success")
            task = wait_for_task_stage(service, OWNER, "retry-task", "success")

            self.assertEqual(calls, 2)
            self.assertEqual(task["attempt"], 2)
            self.assertEqual(task["data"][0]["url"], "http://example.test/retried.png")

    def test_startup_marks_unfinished_tasks_as_error(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "image_tasks.json"
            path.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {
                                "id": "queued-task",
                                "owner_id": "owner-1",
                                "status": "queued",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                            {
                                "id": "running-task",
                                "owner_id": "owner-1",
                                "status": "running",
                                "mode": "generate",
                                "model": "gpt-image-2",
                                "created_at": "2099-01-01 00:00:00",
                                "updated_at": "2099-01-01 00:00:00",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )

            service = self.make_service(path)
            result = service.list_tasks(OWNER, ["queued-task", "running-task"])

            self.assertEqual([item["status"] for item in result["items"]], ["error", "error"])
            self.assertTrue(all("已中断" in item.get("error", "") for item in result["items"]))
            self.assertTrue(all(item["progress"] == 100 for item in result["items"]))
            self.assertTrue(all(item["progress_message"] == "失败" for item in result["items"]))

    def test_cancel_running_task_ignores_late_handler_result(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            started = False

            def handler(_payload):
                nonlocal started
                started = True
                time.sleep(0.1)
                return {"data": [{"url": "http://example.test/late.png"}]}

            service = self.make_service(Path(tmp_dir) / "image_tasks.json", handler)
            service.submit_generation(
                OWNER,
                client_task_id="cancel-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            deadline = time.time() + 1
            while not started and time.time() < deadline:
                time.sleep(0.01)

            cancelled = service.cancel_tasks(OWNER, ["cancel-task"])
            time.sleep(0.2)
            result = service.list_tasks(OWNER, ["cancel-task"])

            self.assertEqual(cancelled["cancelled_ids"], ["cancel-task"])
            self.assertEqual(result["items"][0]["status"], "cancelled")
            self.assertEqual(result["items"][0].get("data"), [])
            self.assertEqual(result["items"][0]["progress"], 100)
            self.assertEqual(result["items"][0]["progress_message"], "已取消")

    def test_cancel_terminal_task_leaves_it_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "image_tasks.json")
            service.submit_generation(
                OWNER,
                client_task_id="done-task",
                prompt="cat",
                model="gpt-image-2",
                size=None,
                base_url="http://local.test",
            )
            wait_for_task(service, OWNER, "done-task", "success")

            cancelled = service.cancel_tasks(OWNER, ["done-task", "missing-task"])
            result = service.list_tasks(OWNER, ["done-task"])

            self.assertEqual(cancelled["cancelled_ids"], [])
            self.assertEqual(cancelled["missing_ids"], ["missing-task"])
            self.assertEqual(result["items"][0]["status"], "success")


if __name__ == "__main__":
    unittest.main()
