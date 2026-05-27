import tempfile
import sys
import types
import unittest
from pathlib import Path

fastapi_stub = types.ModuleType("fastapi")


class HTTPException(Exception):
    pass


fastapi_stub.HTTPException = HTTPException
concurrency_stub = types.ModuleType("fastapi.concurrency")
concurrency_stub.run_in_threadpool = lambda func, *args, **kwargs: func(*args, **kwargs)
responses_stub = types.ModuleType("fastapi.responses")
responses_stub.JSONResponse = object
responses_stub.StreamingResponse = object
helper_stub = types.ModuleType("utils.helper")
helper_stub.anthropic_sse_stream = lambda items: items
helper_stub.sse_json_stream = lambda items: items
sys.modules.setdefault("fastapi", fastapi_stub)
sys.modules.setdefault("fastapi.concurrency", concurrency_stub)
sys.modules.setdefault("fastapi.responses", responses_stub)
sys.modules.setdefault("utils.helper", helper_stub)

from services.log_service import LogService


class LogServiceRedactionTests(unittest.TestCase):
    def test_sensitive_values_are_redacted_before_persisting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = LogService(Path(tmp_dir) / "logs.jsonl")
            service.add(
                "call",
                "test",
                {
                    "access_token": "secret-access-token",
                    "nested": {
                        "authorization": "Bearer very-secret-token",
                        "message": "api_key=sk-abcdef1234567890 and cookie=session-value",
                    },
                    "items": [
                        {"refresh_token": "secret-refresh-token"},
                    ],
                },
            )

            raw = (Path(tmp_dir) / "logs.jsonl").read_text(encoding="utf-8")

            self.assertNotIn("secret-access-token", raw)
            self.assertNotIn("very-secret-token", raw)
            self.assertNotIn("sk-abcdef1234567890", raw)
            self.assertNotIn("session-value", raw)
            self.assertNotIn("secret-refresh-token", raw)
            self.assertIn("***", raw)


if __name__ == "__main__":
    unittest.main()
