from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import services.image_service as image_service
import services.protocol.conversation as conversation


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def fake_config(tmp_dir: str):
    root = Path(tmp_dir)
    images_dir = root / "images"
    thumbnails_dir = root / "thumbs"
    images_dir.mkdir(parents=True, exist_ok=True)
    thumbnails_dir.mkdir(parents=True, exist_ok=True)
    return SimpleNamespace(
        images_dir=images_dir,
        image_thumbnails_dir=thumbnails_dir,
        base_url="http://local.test",
        cleanup_old_images=lambda: 0,
    )


class ImageServiceOwnerTests(unittest.TestCase):
    def test_saved_images_are_grouped_by_owner_and_listed_by_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            cfg = fake_config(tmp_dir)
            with (
                mock.patch.object(conversation, "config", cfg),
                mock.patch.object(image_service, "config", cfg),
            ):
                own_url = conversation.save_image_bytes(PNG_1X1, "http://local.test", owner_id="user/one")
                other_url = conversation.save_image_bytes(PNG_1X1, "http://local.test", owner_id="user-two")

                self.assertIn("/images/users/user_one/", own_url)
                self.assertIn("/images/users/user-two/", other_url)

                owner_items = image_service.list_images(
                    "http://local.test",
                    identity={"id": "user/one", "role": "user"},
                )["items"]
                other_items = image_service.list_images(
                    "http://local.test",
                    identity={"id": "user-two", "role": "user"},
                )["items"]
                admin_items = image_service.list_images(
                    "http://local.test",
                    identity={"id": "admin", "role": "admin"},
                )["items"]

                self.assertEqual(len(owner_items), 1)
                self.assertEqual(len(other_items), 1)
                self.assertEqual(len(admin_items), 2)
                self.assertTrue(str(owner_items[0]["path"]).startswith("users/user_one/"))
                self.assertTrue(str(other_items[0]["path"]).startswith("users/user-two/"))

    def test_user_cannot_download_or_delete_other_users_images(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            cfg = fake_config(tmp_dir)
            with (
                mock.patch.object(conversation, "config", cfg),
                mock.patch.object(image_service, "config", cfg),
            ):
                conversation.save_image_bytes(PNG_1X1, "http://local.test", owner_id="owner-a")
                conversation.save_image_bytes(PNG_1X1, "http://local.test", owner_id="owner-b")
                owner_b_path = image_service.list_images(
                    "http://local.test",
                    identity={"id": "owner-b", "role": "user"},
                )["items"][0]["path"]

                result = image_service.delete_images(
                    [str(owner_b_path)],
                    identity={"id": "owner-a", "role": "user"},
                )
                self.assertEqual(result["removed"], 0)
                self.assertFalse(image_service.image_path_is_accessible(str(owner_b_path), {"id": "owner-a", "role": "user"}))
                self.assertTrue(image_service.image_path_is_accessible(str(owner_b_path), {"id": "owner-b", "role": "user"}))


if __name__ == "__main__":
    unittest.main()
