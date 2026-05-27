from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from services.image_task_service import ImageTaskService


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}


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


class ImageTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, handler=None) -> ImageTaskService:
        return ImageTaskService(
            path,
            generation_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/image.png"}]}),
            edit_handler=handler or (lambda _payload: {"data": [{"url": "http://example.test/edit.png"}]}),
            retention_days_getter=lambda: 30,
        )

    def test_duplicate_submit_uses_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
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
        with tempfile.TemporaryDirectory() as tmp_dir:
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
