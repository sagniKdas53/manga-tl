"""python3 -m unittest scripts/quality/test_compare_layout.py"""

import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from compare_layout import compare


def region(key="a", resolution="resolved-local-split", box=(0, 0, 100, 100), px=20, text="t", hand=False):
    return {
        "key": key,
        "resolution": resolution,
        "box": list(box),
        "px": px,
        "text_sha": text,
        "hand": hand,
    }


def snapshot(*regions, overlaps=()):
    return {
        "meta": {"label": "x", "repo_commit": "abc"},
        "pages": [{"page": "p1", "width": 1000, "regions": list(regions), "overlaps": [list(o) for o in overlaps]}],
    }


def kinds(report):
    return [violation["kind"] for violation in report["violations"]]


class CompareLayout(unittest.TestCase):
    def test_identical_snapshots_have_no_violations(self):
        before = snapshot(region())
        self.assertEqual(kinds(compare(before, copy.deepcopy(before))), [])

    def test_a_box_moved_inside_the_declared_class_passes(self):
        report = compare(
            snapshot(region()), snapshot(region(box=(0, 0, 150, 100), px=30)), allow_box=["resolved-local-split"]
        )
        self.assertEqual(kinds(report), [])
        self.assertEqual(report["counts"]["boxes_moved"], 1)
        self.assertEqual(report["counts"]["bigger"], 1)

    def test_a_box_moved_outside_the_declared_class_fails(self):
        before = snapshot(region(resolution="resolved-bubble-container"))
        after = snapshot(region(resolution="resolved-bubble-container", box=(0, 0, 150, 100)))
        self.assertEqual(kinds(compare(before, after, allow_box=["resolved-local-split"])), ["box-moved-outside-footprint"])

    def test_a_hand_edited_element_may_never_move_even_in_the_declared_class(self):
        report = compare(
            snapshot(region(hand=True)),
            snapshot(region(hand=True, box=(0, 0, 150, 100))),
            allow_box=["resolved-local-split"],
        )
        self.assertEqual(kinds(report), ["hand-edited-moved"])

    def test_regrouping_outside_the_declared_class_fails(self):
        before = snapshot(region(key="a", resolution="resolved-bubble-container"))
        after = snapshot(region(key="b", resolution="resolved-bubble-container"))
        self.assertEqual(sorted(set(kinds(compare(before, after)))), ["regrouped-outside-footprint"])

    def test_regrouping_inside_the_declared_class_passes(self):
        before = snapshot(region(key="a", resolution="review-missing-container"))
        after = snapshot(
            region(key="b", resolution="review-missing-container"), region(key="c", resolution="review-missing-container")
        )
        report = compare(before, after, allow_grouping=["review-missing-container"])
        self.assertEqual(kinds(report), [])
        self.assertEqual(report["counts"]["regrouped"], 3)

    def test_a_new_overlap_fails_and_an_old_one_does_not(self):
        regions = (region(key="a"), region(key="b"))
        old = snapshot(*regions, overlaps=[("a", "b", 0.5)])
        self.assertEqual(kinds(compare(old, copy.deepcopy(old))), [])
        self.assertEqual(kinds(compare(snapshot(*regions), old)), ["new-overlap"])

    def test_a_new_text_collision_fails_and_a_removed_one_is_counted(self):
        regions = (region(key="a"), region(key="b"))
        colliding = snapshot(*regions)
        colliding["pages"][0]["text_collisions"] = [["a", "b", 120, 0.2]]
        clear = snapshot(*regions)
        clear["pages"][0]["text_collisions"] = []
        self.assertEqual(kinds(compare(clear, colliding)), ["new-text-collision"])
        report = compare(colliding, clear)
        self.assertEqual(kinds(report), [])
        self.assertEqual((report["counts"]["text_collisions_before"], report["counts"]["text_collisions_after"]), (1, 0))

    def test_an_older_snapshot_without_collisions_is_not_compared_on_them(self):
        # Snapshots before 2026-11-08 have no text_collisions; every collision would look new.
        regions = (region(key="a"), region(key="b"))
        old = snapshot(*regions)
        new = snapshot(*regions)
        new["pages"][0]["text_collisions"] = [["a", "b", 120, 0.2]]
        report = compare(old, new)
        self.assertEqual(kinds(report), [])
        self.assertIsNone(report["counts"]["text_collisions_before"])

    def test_snapshots_without_text_collisions_still_compare(self):
        report = compare(snapshot(region()), snapshot(region()))
        self.assertEqual(kinds(report), [])
        self.assertIsNone(report["counts"]["text_collisions_after"])

    def test_the_same_text_set_much_smaller_fails(self):
        self.assertEqual(kinds(compare(snapshot(region(px=40)), snapshot(region(px=30)))), ["smaller"])
        self.assertEqual(kinds(compare(snapshot(region(px=40)), snapshot(region(px=39)))), [])

    def test_reworded_text_is_counted_and_its_size_is_not_compared(self):
        report = compare(snapshot(region(px=40)), snapshot(region(px=20, text="other")))
        self.assertEqual(kinds(report), [])
        self.assertEqual(report["counts"]["reworded"], 1)

    def test_an_accepted_item_is_reported_with_its_reason_and_does_not_fail(self):
        report = compare(snapshot(region(px=40)), snapshot(region(px=30)), accepted={"p1:a": "still large"})
        self.assertEqual(kinds(report), [])
        self.assertEqual(report["accepted"][0]["reason"], "still large")

    def test_text_appearing_is_counted_and_is_not_a_move(self):
        hidden = region()
        hidden["box"], hidden["px"], hidden["text_sha"] = None, None, None
        report = compare(snapshot(hidden), snapshot(region()))
        self.assertEqual(kinds(report), [])
        self.assertEqual(report["counts"]["newly_drawn"], 1)
        self.assertEqual(report["counts"]["boxes_moved"], 0)

    def test_text_disappearing_fails(self):
        hidden = region()
        hidden["box"], hidden["px"], hidden["text_sha"] = None, None, None
        self.assertEqual(kinds(compare(snapshot(region()), snapshot(hidden))), ["no-longer-drawn"])

    def test_a_page_missing_from_one_snapshot_fails(self):
        before = snapshot(region())
        after = copy.deepcopy(before)
        after["pages"] = []
        self.assertEqual(kinds(compare(before, after)), ["page-missing"])


if __name__ == "__main__":
    unittest.main()
