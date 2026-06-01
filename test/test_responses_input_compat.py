from __future__ import annotations

import base64
import unittest
from unittest import mock

from services.protocol import openai_v1_response
from services.protocol.conversation import ImageOutput


class ResponsesInputCompatTests(unittest.TestCase):
    def test_messages_from_input_preserves_inline_image_parts(self) -> None:
        messages = openai_v1_response.messages_from_input([
            {"type": "input_text", "text": "describe this"},
            {"type": "input_image", "image_url": "https://example.test/cat.png"},
        ])

        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["role"], "user")
        self.assertEqual(messages[0]["content"][0]["type"], "input_text")
        self.assertEqual(messages[0]["content"][1]["type"], "input_image")
        self.assertEqual(messages[0]["content"][1]["image_url"], "https://example.test/cat.png")

    def test_extract_response_image_accepts_top_level_input_image(self) -> None:
        image_b64 = base64.b64encode(b"image-bytes").decode("ascii")

        image = openai_v1_response.extract_response_image({
            "type": "input_image",
            "image_url": f"data:image/png;base64,{image_b64}",
        })

        self.assertIsNotNone(image)
        self.assertEqual(image[0], b"image-bytes")
        self.assertEqual(image[1], "image/png")

    def test_response_image_tool_size_and_quality_reach_generation_request(self) -> None:
        captured = {}

        def fake_stream(request):
            captured["request"] = request
            yield ImageOutput(
                kind="result",
                model=request.model,
                index=1,
                total=1,
                data=[{"b64_json": base64.b64encode(b"result").decode("ascii")}],
            )

        with mock.patch.object(openai_v1_response, "stream_image_outputs_with_pool", fake_stream):
            events = list(openai_v1_response.response_events({
                "model": "gpt-image-2",
                "input": [{"type": "input_text", "text": "draw a cat"}],
                "tools": [{"type": "image_generation", "size": "3:4", "quality": "high"}],
            }))

        request = captured["request"]
        self.assertEqual(request.size, "3:4")
        self.assertEqual(request.quality, "high")
        completed = next(event["response"] for event in events if event.get("type") == "response.completed")
        self.assertEqual(completed["output"][0]["type"], "image_generation_call")


if __name__ == "__main__":
    unittest.main()
