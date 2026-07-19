import importlib.util
import sys
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "build_render_scale_apk.py"
SPEC = importlib.util.spec_from_file_location("render_scale_build", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class RenderScaleBuildTests(unittest.TestCase):
    def test_site1_marker_accepts_source_and_ffdec_canonical_forms(self):
        self.assertTrue(
            MODULE.has_site1_marker("_loc12_.scale = _loc12_.scale / 6;")
        )
        self.assertTrue(MODULE.has_site1_marker("_loc12_.scale /= 6;"))
        self.assertFalse(MODULE.has_site1_marker("_loc12_.scale = 1;"))


if __name__ == "__main__":
    unittest.main()
