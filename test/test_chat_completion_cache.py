from __future__ import annotations

import unittest
from unittest import mock

from services.config import config
from services.protocol import openai_v1_chat_complete
from services.protocol.chat_completion_cache import cache_key, chat_completion_cache, normalize_text_messages


class ChatCompletionCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.old_settings = config.data.get("chat_completion_cache")
        config.data["chat_completion_cache"] = {
            "enabled": True,
            "ttl_seconds": 60,
            "max_entries": 32,
            "dedupe_inflight": True,
            "stream_cache": True,
            "normalize_messages": True,
            "drop_adjacent_duplicates": True,
            "drop_assistant_history": False,
        }
        chat_completion_cache.clear()

    def tearDown(self) -> None:
        if self.old_settings is None:
            config.data.pop("chat_completion_cache", None)
        else:
            config.data["chat_completion_cache"] = self.old_settings
        chat_completion_cache.clear()

    def test_cache_key_ignores_non_text_transport_noise(self) -> None:
        messages = [{"role": "user", "content": "hello"}]
        first = cache_key({"model": "auto", "stream": False, "unused": "a"}, messages, stream=False)
        second = cache_key({"model": "auto", "stream": False, "unused": "b"}, messages, stream=False)

        self.assertEqual(first, second)

    def test_normalize_text_messages_drops_adjacent_duplicates(self) -> None:
        message = {"role": "user", "content": "same"}

        normalized = normalize_text_messages([message, dict(message), {"role": "assistant", "content": "ok"}])

        self.assertEqual(normalized, [message, {"role": "assistant", "content": "ok"}])

    def test_non_stream_chat_completion_uses_cached_response(self) -> None:
        body = {"model": "auto", "messages": [{"role": "user", "content": "hello"}]}

        with (
            mock.patch.object(openai_v1_chat_complete, "text_backend", return_value=object()),
            mock.patch.object(openai_v1_chat_complete, "collect_text", return_value="cached hello") as collect_text,
        ):
            first = openai_v1_chat_complete.handle(dict(body))
            second = openai_v1_chat_complete.handle(dict(body))

        self.assertEqual(collect_text.call_count, 1)
        self.assertEqual(first["choices"][0]["message"]["content"], "cached hello")
        self.assertEqual(second["choices"][0]["message"]["content"], "cached hello")

    def test_stream_chat_completion_uses_cached_chunks(self) -> None:
        body = {"model": "auto", "messages": [{"role": "user", "content": "hello"}], "stream": True}
        chunks = [
            openai_v1_chat_complete.completion_chunk("auto", {"role": "assistant", "content": "a"}),
            openai_v1_chat_complete.completion_chunk("auto", {}, "stop"),
        ]

        with (
            mock.patch.object(openai_v1_chat_complete, "text_backend", return_value=object()),
            mock.patch.object(openai_v1_chat_complete, "stream_text_chat_completion", return_value=iter(chunks)) as stream_text,
        ):
            first = list(openai_v1_chat_complete.handle(dict(body)))
            second = list(openai_v1_chat_complete.handle(dict(body)))

        self.assertEqual(stream_text.call_count, 1)
        self.assertEqual(first, chunks)
        self.assertEqual(second, chunks)


if __name__ == "__main__":
    unittest.main()
