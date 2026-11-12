import math
import unittest

from zoom_math import (
    clamp_box,
    clean_aspect,
    clean_keys,
    default_box,
    interpolate_box,
    max_width_fraction,
    output_size,
)


class ZoomMathTests(unittest.TestCase):
    def test_fit_width_matches_the_frame_aspect(self):
        self.assertAlmostEqual(max_width_fraction(1920, 1080, 16 / 9), 1.0)
        self.assertAlmostEqual(max_width_fraction(1920, 1080, 1), 1080 / 1920)
        self.assertAlmostEqual(max_width_fraction(1080, 1920, 9 / 16), 1.0)

    def test_default_box_is_centered_at_two_times_zoom(self):
        box = default_box(1920, 1080, 16 / 9)
        self.assertEqual(box["cx"], 0.5)
        self.assertEqual(box["cy"], 0.5)
        self.assertAlmostEqual(box["w"], 0.5)

    def test_clamp_limits_zoom(self):
        fitted = max_width_fraction(1920, 1080, 1)
        huge = clamp_box({"cx": 2, "cy": -1, "w": 5}, 1920, 1080, 1)
        tiny = clamp_box({"cx": 0.2, "cy": 0.2, "w": 0.0001}, 1920, 1080, 1)
        self.assertEqual((huge["cx"], huge["cy"]), (1.0, 0.0))
        self.assertAlmostEqual(huge["w"], fitted)
        self.assertAlmostEqual(tiny["w"], fitted / 30)

    def test_interpolate_holds_and_blends(self):
        keys = [
            {"t": 1.0, "cx": 0.0, "cy": 0.25, "w": 0.2},
            {"t": 3.0, "cx": 1.0, "cy": 0.75, "w": 0.4},
        ]
        default = {"cx": 0.5, "cy": 0.5, "w": 0.3}
        self.assertEqual(interpolate_box(0.0, [], default)["cx"], 0.5)
        self.assertEqual(interpolate_box(0.2, keys, default)["cx"], 0.0)
        mid = interpolate_box(2.0, keys, default)
        self.assertAlmostEqual(mid["cx"], 0.5)
        self.assertAlmostEqual(mid["cy"], 0.5)
        self.assertAlmostEqual(mid["w"], 0.3)
        self.assertEqual(interpolate_box(9.0, keys, default)["w"], 0.4)
        self.assertEqual(mid["rot"], 0.0)

    def test_interpolate_turns_the_short_way(self):
        keys = [
            {"t": 0.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "rot": math.radians(170)},
            {"t": 2.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "rot": math.radians(-170)},
        ]
        mid = interpolate_box(1.0, keys, {"cx": 0.5, "cy": 0.5, "w": 0.2})
        self.assertAlmostEqual(mid["rot"], math.pi, places=5)
        straight = interpolate_box(
            1.0,
            [
                {"t": 0.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "rot": math.radians(10)},
                {"t": 2.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "rot": math.radians(30)},
            ],
            {"cx": 0.5, "cy": 0.5, "w": 0.2},
        )
        self.assertAlmostEqual(straight["rot"], math.radians(20), places=5)

    def test_clean_keys_keeps_the_turn(self):
        meta = {"fps": 10, "duration": 2}
        keys = clean_keys(
            [
                {"t": 0.06, "cx": 0.1, "cy": 0.2, "w": 0.3},
                {"t": 0.08, "cx": 0.4, "cy": 0.5, "w": 0.6},
                {"t": 1.0, "cx": 0.7, "cy": 0.8, "w": 0.2},
            ],
            meta,
        )
        self.assertEqual(len(keys), 2)
        self.assertAlmostEqual(keys[0]["t"], 0.1)
        self.assertAlmostEqual(keys[0]["cx"], 0.4)
        self.assertAlmostEqual(keys[0]["rot"], 0.0)
        self.assertAlmostEqual(keys[1]["t"], 1.0)
        turned = clean_keys([{"t": 0.0, "cx": 0.5, "cy": 0.5, "w": 0.2, "rot": math.radians(450)}], meta)
        self.assertAlmostEqual(turned[0]["rot"], math.radians(90), places=5)

    def test_aspect_and_even_output_size(self):
        with self.assertRaises(ValueError):
            clean_aspect(0, 1)
        with self.assertRaises(ValueError):
            clean_aspect(1, 100)
        self.assertEqual(output_size(16 / 9, 1280), (1280, 720))
        self.assertEqual(output_size(1, 1650)[0] % 2, 0)
        width, height = output_size(9 / 16, 1000)
        self.assertEqual(height, 1000)
        self.assertEqual(width % 2, 0)


if __name__ == "__main__":
    unittest.main()
