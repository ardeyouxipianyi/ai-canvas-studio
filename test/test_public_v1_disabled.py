from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from api import create_app


class PublicV1DisabledTests(unittest.TestCase):
    def test_v1_root_is_not_served(self):
        response = TestClient(create_app()).get("/v1")

        self.assertEqual(response.status_code, 404)

    def test_v1_images_generation_is_not_served(self):
        response = TestClient(create_app()).post(
            "/v1/images/generations",
            headers={"Authorization": "Bearer ai-canvas-studio"},
            json={"prompt": "cat"},
        )

        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
