import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from engine import NO_WINDOW, crop_image, ffmpeg_exe, parse_probe, probe, render_pdf, render_preview
from tests.clipfactory import norm_center, tracking_geometry, write_tracking_clip
from zoom_math import box_pixels


class CropTests(unittest.TestCase):
    def test_centered_crop_samples_the_marked_region(self):
        import numpy as np

        frame = np.zeros((80, 100, 3), dtype=np.uint8)
        frame[:, :] = (10, 20, 30)
        # w = 0.5 on a 100px frame is 50px wide. Aspect 1.25 makes the box 50 x 40.
        frame[20:60, 25:75] = (255, 255, 255)
        image = crop_image(frame, {"cx": 0.5, "cy": 0.5, "w": 0.5}, 1.25, (50, 40))
        self.assertEqual(image.size, (50, 40))
        self.assertGreater(image.getpixel((25, 20))[0], 250)
        self.assertGreater(image.getpixel((10, 10))[0], 250)

    def test_crop_outside_the_frame_is_black(self):
        import numpy as np

        frame = np.full((60, 80, 3), 255, dtype=np.uint8)
        # Box is 40px square, centered on the left edge, so the left half is outside.
        image = crop_image(frame, {"cx": 0.0, "cy": 0.5, "w": 0.5}, 1.0, (40, 40))
        self.assertEqual(image.getpixel((4, 20)), (0, 0, 0))
        self.assertEqual(image.getpixel((30, 20)), (255, 255, 255))

    def test_clockwise_quarter_turn_brings_the_right_edge_to_the_top(self):
        import math
        import numpy as np

        frame = np.zeros((80, 80, 3), dtype=np.uint8)
        frame[:, :] = (20, 40, 80)
        # 40px square centered at (40, 40). White sits on its right edge.
        frame[36:44, 54:60] = (255, 255, 255)
        image = crop_image(
            frame,
            {"cx": 0.5, "cy": 0.5, "w": 0.5, "rot": math.pi / 2},
            1.0,
            (40, 40),
        )
        self.assertGreater(image.getpixel((20, 2))[0], 200)
        self.assertLess(image.getpixel((20, 36))[0], 80)


class ProbeTests(unittest.TestCase):
    def test_parse_banner(self):
        banner = """
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'demo.mp4':
  Duration: 00:00:04.00, start: 0.000000, bitrate: 420 kb/s
  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 640x360 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 15360 tbn
"""
        meta = parse_probe(banner, Path("demo.mp4"))
        self.assertIsNotNone(meta)
        assert meta is not None
        self.assertEqual((meta["width"], meta["height"]), (640, 360))
        self.assertEqual(meta["fps"], 30)
        self.assertEqual(meta["duration"], 4)
        self.assertEqual(meta["codec"], "h264")
        self.assertTrue(meta["browser_safe"])

    def test_rotation_swaps_display_size(self):
        banner = """
  Duration: 00:00:01.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0: Video: hevc (Main), yuv420p, 1920x1080, 30 fps, 30 tbr
  Side data:
  displaymatrix: rotation of -90.00 degrees
"""
        meta = parse_probe(banner, Path("phone.mov"))
        assert meta is not None
        self.assertEqual((meta["width"], meta["height"]), (1080, 1920))
        self.assertFalse(meta["browser_safe"])


class PipelineTests(unittest.TestCase):
    def test_preview_keeps_the_moving_dot_centered(self):
        geo = tracking_geometry()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source = folder / "dot.mp4"
            write_tracking_clip(source, geo)
            meta = probe(source)
            self.assertEqual((meta["width"], meta["height"]), (geo["width"], geo["height"]))
            self.assertAlmostEqual(meta["fps"], geo["fps"], places=2)

            last = geo["frames"] - 1
            cx0, cy0 = norm_center(0, geo)
            cx1, cy1 = norm_center(last, geo)
            params = {
                "aspect": 1.0,
                "start": 0.0,
                "end": meta["duration"],
                "step": 1,
                "crosshair": False,
                "keyframes": [
                    {"t": 0.0, "cx": cx0, "cy": cy0, "w": geo["box_w"]},
                    {"t": last / geo["fps"], "cx": cx1, "cy": cy1, "w": geo["box_w"]},
                ],
            }
            preview = folder / "review.mp4"
            result = render_preview(source, preview, meta, params, long_edge=320)
            self.assertGreaterEqual(result["frames"], geo["frames"] - 2)
            self.assertTrue(preview.is_file())

            png = folder / "mid.png"
            subprocess.run(
                [
                    ffmpeg_exe(),
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(preview),
                    "-ss",
                    "1.0",
                    "-frames:v",
                    "1",
                    str(png),
                ],
                check=True,
                creationflags=NO_WINDOW,
            )
            image = Image.open(png).convert("RGB")
            cx, cy = image.size[0] // 2, image.size[1] // 2
            center = image.getpixel((cx, cy))
            side = image.getpixel((cx - 80, cy))
            self.assertGreater(center[0], 200, center)
            self.assertGreater(center[1], 200, center)
            self.assertGreater(center[2], 200, center)
            self.assertLess(side[0], 160, side)

            # The box used at 1s should agree with the painted dot, within a pixel.
            x0, y0, box_w, _box_h = box_pixels(
                {"cx": (cx0 + cx1) / 2, "cy": (cy0 + cy1) / 2, "w": geo["box_w"]},
                geo["width"],
                geo["height"],
                1.0,
            )
            self.assertAlmostEqual(x0 + box_w / 2, (240 + 720) / 2, delta=geo["width"] * 0.02)

    def test_pdf_is_a_page_per_kept_frame(self):
        geo = tracking_geometry()
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source = folder / "dot.mp4"
            write_tracking_clip(source, geo)
            meta = probe(source)
            params = {
                "aspect": 4 / 3,
                "start": 0.2,
                "end": 1.4,
                "step": 4,
                "crosshair": False,
                "keyframes": [],
            }
            dest = folder / "frames.pdf"
            result = render_pdf(source, dest, meta, params, long_edge=160)
            data = dest.read_bytes()
            self.assertTrue(data.startswith(b"%PDF"))
            self.assertGreaterEqual(result["frames"], 3)
            self.assertLessEqual(result["frames"], 8)
            pages = data.count(b"/Type /Page") - data.count(b"/Type /Pages")
            self.assertEqual(pages, result["frames"])


if __name__ == "__main__":
    unittest.main()
