"""python3 -m unittest scripts/quality/test_check_ledger_row.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from check_ledger_row import COORDINATOR, LABEL, added_a_row, affecting, runs_layout_check, verdict

ROW = "+| 7 | A change | #1 | none | 0 | 0 / 0 | 0 | 90 | 168 | 0 | Prediction |"


class LedgerRule(unittest.TestCase):
    def test_a_worker_pin_counts_so_a_dependency_bump_needs_a_row(self):
        _, failure = verdict(["worker"], "", "", [])
        self.assertIn("worker", failure)

    def test_the_fitter_and_the_renderer_count(self):
        self.assertEqual(affecting(["packages/page-scene/src/layout.ts"], ""), ["packages/page-scene/src/layout.ts"])
        self.assertTrue(affecting(["services/page-renderer/src/renderer.mjs"], ""))
        self.assertTrue(affecting(["backend-rust/src/page_scene_builder.rs"], ""))

    def test_unrelated_paths_do_not_count(self):
        self.assertEqual(affecting(["frontend/src/App.tsx", "docs/issues.md", "README.md"], ""), [])
        self.assertIsNone(verdict(["frontend/src/App.tsx"], "", "", [])[1])

    def test_the_coordinator_counts_only_for_its_text_box_code(self):
        self.assertEqual(affecting([COORDINATOR], "+    let retries = 3;\n-    let retries = 2;"), [])
        self.assertEqual(affecting([COORDINATOR], "+    let b = grow_into_safe_text(a);"), [COORDINATOR])
        self.assertEqual(affecting([COORDINATOR], "-const OUTLINE_WORTH_LEAVING: f64 = 1.4;"), [COORDINATOR])

    def test_a_row_satisfies_the_rule(self):
        self.assertIsNone(verdict(["worker"], "", ROW, [])[1])

    def test_prose_in_the_ledger_is_not_a_row(self):
        self.assertFalse(added_a_row("+Some words about the run.\n+| --- | --- |\n+| Tool | what it does |"))
        self.assertIsNotNone(verdict(["worker"], "", "+Some words.", [])[1])

    def test_removing_a_row_is_not_adding_one(self):
        self.assertFalse(added_a_row(ROW.replace("+", "-", 1)))

    def test_the_label_is_an_explicit_way_out(self):
        self.assertIsNone(verdict(["worker"], "", "", [LABEL])[1])

    def test_a_change_to_the_check_itself_runs_the_check_without_needing_a_row(self):
        # #335 changed layout_ci.cjs and CI skipped the layout check, so a broken check could merge.
        for path in ("scripts/quality/layout_ci.cjs", ".github/workflows/ci-layout.yml"):
            self.assertTrue(runs_layout_check([path], []))
            self.assertIsNone(verdict([path], "", "", [])[1])
        self.assertFalse(runs_layout_check(["frontend/src/App.tsx"], []))
        self.assertTrue(runs_layout_check(["frontend/src/App.tsx"], ["worker"]))

    def test_it_reports_affecting_paths_even_when_it_passes_so_the_layout_check_runs(self):
        found, failure = verdict(["worker"], "", ROW, [])
        self.assertEqual(found, ["worker"])
        self.assertIsNone(failure)


if __name__ == "__main__":
    unittest.main()
