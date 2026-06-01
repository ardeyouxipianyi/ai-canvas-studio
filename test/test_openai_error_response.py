from __future__ import annotations

import unittest

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.errors import install_exception_handlers


class OpenAICompatibleErrorResponseTests(unittest.TestCase):
    def test_v1_http_exception_uses_openai_error_shape(self):
        app = FastAPI()
        install_exception_handlers(app)

        @app.get("/v1/test-error")
        def test_error():
            raise HTTPException(status_code=400, detail={"error": "bad image"})

        response = TestClient(app).get("/v1/test-error")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {
            "error": {
                "message": "bad image",
                "type": "invalid_request_error",
                "param": None,
                "code": "bad_request",
            }
        })

    def test_non_v1_http_exception_keeps_fastapi_detail_shape(self):
        app = FastAPI()
        install_exception_handlers(app)

        @app.get("/api/test-error")
        def test_error():
            raise HTTPException(status_code=400, detail={"error": "bad image"})

        response = TestClient(app).get("/api/test-error")

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": {"error": "bad image"}})


if __name__ == "__main__":
    unittest.main()
