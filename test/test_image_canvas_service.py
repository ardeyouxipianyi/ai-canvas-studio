from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from services.image_canvas_service import ImageCanvasService


class ImageCanvasServiceTests(unittest.TestCase):
    def test_projects_are_isolated_by_owner(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageCanvasService(Path(tmp_dir) / "canvas.json")
            owner_a = {"id": "user-a", "name": "A", "role": "user"}
            owner_b = {"id": "user-b", "name": "B", "role": "user"}

            service.save_project(owner_a, {"id": "canvas-1", "title": "A 的画布", "nodes": [], "edges": []})
            service.save_project(owner_b, {"id": "canvas-1", "title": "B 的画布", "nodes": [], "edges": []})

            self.assertEqual([item["title"] for item in service.list_projects(owner_a)], ["A 的画布"])
            self.assertEqual([item["title"] for item in service.list_projects(owner_b)], ["B 的画布"])

            self.assertTrue(service.delete_project(owner_a, "canvas-1"))
            self.assertEqual(service.list_projects(owner_a), [])
            self.assertEqual([item["title"] for item in service.list_projects(owner_b)], ["B 的画布"])


    def test_node_favorite_flag_is_persisted(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageCanvasService(Path(tmp_dir) / "canvas.json")
            owner = {"id": "user-a", "name": "A", "role": "user"}

            saved = service.save_project(
                owner,
                {
                    "id": "canvas-1",
                    "title": "Canvas",
                    "nodes": [
                        {
                            "id": "node-1",
                            "type": "image",
                            "title": "Result",
                            "status": "success",
                            "progress": 100,
                            "progressMessage": "已完成",
                            "favorite": True,
                            "url": "https://example.com/image.png",
                        }
                    ],
                    "edges": [],
                },
            )

            self.assertTrue(saved["nodes"][0]["favorite"])
            self.assertEqual(saved["nodes"][0]["progress"], 100)
            self.assertEqual(saved["nodes"][0]["progressMessage"], "已完成")
            reloaded = ImageCanvasService(Path(tmp_dir) / "canvas.json")
            [project] = reloaded.list_projects(owner)
            self.assertTrue(project["nodes"][0]["favorite"])
            self.assertEqual(project["nodes"][0]["progress"], 100)
            self.assertEqual(project["nodes"][0]["progressMessage"], "已完成")

    def test_mark_images_deleted_updates_canvas_nodes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = ImageCanvasService(Path(tmp_dir) / "canvas.json")
            owner = {"id": "user-a", "name": "A", "role": "user"}
            image_path = "users/user-a/2026/07/07/result.png"

            service.save_project(
                owner,
                {
                    "id": "canvas-1",
                    "title": "Canvas",
                    "nodes": [
                        {
                            "id": "node-1",
                            "type": "image",
                            "title": "Result",
                            "status": "success",
                            "url": f"http://local.test/images/{image_path}",
                        }
                    ],
                    "edges": [],
                },
            )

            updated = service.mark_images_deleted(owner, [image_path])

            self.assertEqual(updated, 1)
            [project] = service.list_projects(owner)
            node = project["nodes"][0]
            self.assertEqual(node["status"], "error")
            self.assertEqual(node["progress"], 100)
            self.assertEqual(node["progressMessage"], "图片资产已删除")
            self.assertEqual(node["error"], "图片资产已删除")
            self.assertNotIn("url", node)


if __name__ == "__main__":
    unittest.main()
