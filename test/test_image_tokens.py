from __future__ import annotations

import unittest

from utils.image_tokens import (
    count_image_input_tokens,
    count_image_output_tokens,
    image_usage,
)


class ImageTokenTests(unittest.TestCase):
    def test_patch_token_examples_match_upstream(self) -> None:
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-4.1-mini", "high"), 1659)
        self.assertEqual(count_image_input_tokens(1800, 2400, "gpt-4.1-mini", "high"), 2353)

    def test_image_input_tokens_force_gpt_54_mini(self) -> None:
        expected = count_image_input_tokens(1024, 1024, "gpt-5.4-mini", "low")
        self.assertEqual(expected, 415)
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-4o", "low"), expected)
        self.assertEqual(count_image_input_tokens(1024, 1024, "gpt-image-2", "low"), expected)

    def test_image_output_tokens_scale_by_count_and_size(self) -> None:
        single = count_image_output_tokens("1024x1024", "auto", 1)
        self.assertGreater(single, 0)
        self.assertEqual(count_image_output_tokens("1024x1024", "auto", 2), single * 2)

    def test_image_usage_includes_image_token_details(self) -> None:
        usage = image_usage(input_text_tokens=7, input_image_tokens=415, output_tokens=1056)

        self.assertEqual(usage["input_tokens"], 422)
        self.assertEqual(usage["output_tokens"], 1056)
        self.assertEqual(usage["total_tokens"], 1478)
        self.assertEqual(usage["input_tokens_details"]["image_tokens"], 415)
        self.assertEqual(usage["output_tokens_details"]["image_tokens"], 1056)


if __name__ == "__main__":
    unittest.main()
