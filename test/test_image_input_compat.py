from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module
from utils.helper import decode_image_source, extract_image_from_message_content


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}
PNG_BYTES = b"\x89PNG\r\n\x1a\ncompat"
PNG_B64 = base64.b64encode(PNG_BYTES).decode("ascii")


class FakeLoggedCall:
    def __init__(self, *_args, **_kwargs):
        pass

    async def run(self, handler, payload, *_args, **_kwargs):
        return handler(payload)

    def log(self, *_args, **_kwargs):
        pass


class ImageInputCompatTests(unittest.TestCase):
    def test_decode_image_source_accepts_common_data_shapes(self):
        self.assertEqual(decode_image_source(PNG_B64), (PNG_BYTES, "image/png"))
        self.assertEqual(decode_image_source(f"data:image/png;base64,{PNG_B64}"), (PNG_BYTES, "image/png"))
        self.assertEqual(
            decode_image_source({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{PNG_B64}"}}),
            (PNG_BYTES, "image/png"),
        )
        self.assertEqual(
            decode_image_source({"type": "input_image", "image_url": f"data:image/jpeg;base64,{PNG_B64}"}),
            (PNG_BYTES, "image/jpeg"),
        )
        self.assertIsNone(decode_image_source("file:///tmp/image.png"))

    def test_decode_image_source_reads_local_saved_image_urls(self):
        import services.config as config_module

        old_data_dir = config_module.DATA_DIR
        with tempfile.TemporaryDirectory() as tmp_dir:
            config_module.DATA_DIR = Path(tmp_dir)
            image_path = Path(tmp_dir) / "images" / "2026" / "05" / "16" / "saved.png"
            image_path.parent.mkdir(parents=True)
            image_path.write_bytes(PNG_BYTES)
            try:
                self.assertEqual(
                    decode_image_source("http://localhost:8000/images/2026/05/16/saved.png"),
                    (PNG_BYTES, "image/png"),
                )
            finally:
                config_module.DATA_DIR = old_data_dir

    def test_extract_image_from_message_content_accepts_ai_sdk_image_parts(self):
        images = extract_image_from_message_content([
            {"type": "text", "text": "edit this"},
            {"type": "image", "image": PNG_B64, "mediaType": "image/png"},
        ])

        self.assertEqual(images, [(PNG_BYTES, "image/png")])

    def test_v1_image_edits_accepts_json_data_url(self):
        captured_payload = {}

        def fake_handle(payload):
            captured_payload.update(payload)
            return {"created": 1, "data": [{"b64_json": PNG_B64}]}

        app = FastAPI()
        with (
            mock.patch.object(ai_module, "check_request", return_value=None),
            mock.patch.object(ai_module, "require_identity", return_value={"id": "admin", "name": "admin", "role": "admin"}),
            mock.patch.object(ai_module, "LoggedCall", FakeLoggedCall),
            mock.patch.object(ai_module.openai_v1_image_edit, "handle", side_effect=fake_handle),
        ):
            app.include_router(ai_module.create_router())
            client = TestClient(app)
            response = client.post(
                "/v1/images/edits",
                headers=AUTH_HEADERS,
                json={
                    "model": "gpt-image-2",
                    "prompt": "edit this",
                    "image": {"url": f"data:image/png;base64,{PNG_B64}", "type": "image_url"},
                    "quality": "high",
                    "response_format": "b64_json",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["data"][0]["b64_json"], PNG_B64)
        self.assertEqual(captured_payload["prompt"], "edit this")
        self.assertEqual(captured_payload["model"], "gpt-image-2")
        self.assertEqual(captured_payload["quality"], "high")
        self.assertEqual(len(captured_payload["images"]), 1)
        self.assertEqual(captured_payload["images"][0], (PNG_BYTES, "image_1.png", "image/png"))

    def test_v1_image_edits_accepts_json_image_url_field(self):
        captured_payload = {}

        def fake_handle(payload):
            captured_payload.update(payload)
            return {"created": 1, "data": [{"b64_json": PNG_B64}]}

        app = FastAPI()
        with (
            mock.patch.object(ai_module, "check_request", return_value=None),
            mock.patch.object(ai_module, "require_identity", return_value={"id": "admin", "name": "admin", "role": "admin"}),
            mock.patch.object(ai_module, "LoggedCall", FakeLoggedCall),
            mock.patch.object(ai_module.openai_v1_image_edit, "handle", side_effect=fake_handle),
        ):
            app.include_router(ai_module.create_router())
            client = TestClient(app)
            response = client.post(
                "/v1/images/edits",
                headers=AUTH_HEADERS,
                json={
                    "model": "gpt-image-2",
                    "prompt": "edit this",
                    "image_url": f"data:image/png;base64,{PNG_B64}",
                    "response_format": "b64_json",
                },
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(captured_payload["images"], [(PNG_BYTES, "image_1.png", "image/png")])

    def test_v1_image_edits_still_accepts_multipart_uploads(self):
        captured_payload = {}

        def fake_handle(payload):
            captured_payload.update(payload)
            return {"created": 1, "data": [{"b64_json": PNG_B64}]}

        app = FastAPI()
        with (
            mock.patch.object(ai_module, "check_request", return_value=None),
            mock.patch.object(ai_module, "require_identity", return_value={"id": "admin", "name": "admin", "role": "admin"}),
            mock.patch.object(ai_module, "LoggedCall", FakeLoggedCall),
            mock.patch.object(ai_module.openai_v1_image_edit, "handle", side_effect=fake_handle),
        ):
            app.include_router(ai_module.create_router())
            client = TestClient(app)
            response = client.post(
                "/v1/images/edits",
                headers=AUTH_HEADERS,
                data={"model": "gpt-image-2", "prompt": "edit this", "n": "1"},
                files={"image": ("input.png", PNG_BYTES, "image/png")},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(captured_payload["images"]), 1)
        self.assertEqual(captured_payload["images"][0], (PNG_BYTES, "input.png", "image/png"))

if __name__ == "__main__":
    unittest.main()
