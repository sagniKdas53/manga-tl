"""python3 -m unittest scripts/quality/test_predict_collisions.py"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from predict_collisions import GAP_PX, keeps_its_shape, predict_page, trimmed


def row(key, box, bbox=None, text_len=10, hand=False, rotation=0, region_id=None, px=None):
    return {
        "px": px,
        "key": key,
        "region_id": region_id or f"id-{key}",
        "box": list(box),
        "bbox": list(bbox or box),
        "text_len": text_len,
        "hand": hand,
        "rotation": rotation,
    }


class WhoKeepsItsShape(unittest.TestCase):
    def test_a_hand_edited_box_always_keeps_its_shape(self):
        small_hand = row("a", (0, 0, 50, 50), hand=True)
        big = row("b", (0, 0, 400, 400))
        self.assertEqual(keeps_its_shape(small_hand, big), "a")
        self.assertEqual(keeps_its_shape(big, small_hand), "a")

    def test_two_hand_edited_boxes_are_left_for_review(self):
        self.assertIsNone(keeps_its_shape(row("a", (0, 0, 50, 50), hand=True), row("b", (0, 0, 90, 90), hand=True)))

    def test_the_bigger_source_footprint_wins_first(self):
        # The longer English loses to the bigger source footprint: area is the first rung.
        big = row("a", (0, 0, 100, 100), bbox=(0, 0, 100, 200), text_len=5)
        small = row("b", (0, 0, 100, 100), bbox=(0, 0, 100, 100), text_len=80)
        self.assertEqual(keeps_its_shape(big, small), "a")

    def test_about_the_same_footprint_goes_to_the_one_with_more_text(self):
        a = row("a", (0, 0, 100, 100), bbox=(0, 0, 100, 100), text_len=20)
        b = row("b", (0, 0, 100, 100), bbox=(0, 0, 100, 108), text_len=60)
        self.assertEqual(keeps_its_shape(a, b), "b")


class Trimming(unittest.TestCase):
    def test_the_side_that_keeps_the_most_is_cut_back_from_the_keeper(self):
        loser = (100, 100, 200, 100)
        keeper = (250, 50, 200, 200)
        # Cutting the right edge back to the keeper's left keeps 150 - GAP of 200 px of width.
        self.assertEqual(trimmed(loser, keeper), [100, 100, 150 - GAP_PX, 100])

    def test_a_trim_that_would_leave_too_little_is_refused(self):
        self.assertIsNone(trimmed((100, 100, 100, 100), (90, 90, 120, 120)))


class APage(unittest.TestCase):
    def test_only_colliding_text_is_trimmed(self):
        page = {
            "regions": [row("a", (0, 0, 200, 300)), row("b", (180, 0, 100, 300)), row("c", (500, 0, 100, 100))],
            "text_collisions": [["a", "b", 300, 0.2]],
        }
        boxes, review = predict_page(page, trigger="text")
        self.assertEqual(list(boxes), ["id-b"])
        self.assertEqual(boxes["id-b"][0], 200 + GAP_PX)
        self.assertEqual(review, [])

    def test_rotated_text_on_either_side_is_left_for_review_not_trimmed(self):
        # Line boxes are before rotation, so a rotated keeper's boxes don't say where its text is either.
        for rotated in ("a", "b"):
            page = {
                "regions": [
                    row("a", (0, 0, 200, 300), rotation=-12 if rotated == "a" else 0),
                    row("b", (180, 0, 100, 300), rotation=-12 if rotated == "b" else 0),
                ],
                "text_collisions": [["a", "b", 300, 0.2]],
            }
            boxes, review = predict_page(page, trigger="text")
            self.assertEqual(boxes, {})
            self.assertEqual(review[0]["reason"], "rotated")

    def test_a_trim_whose_text_would_come_out_tiny_goes_to_review(self):
        # 1000 px wide: tiny is under 15 px. Cutting b back to the keeper's left edge keeps 51 of 100 px of
        # width, so 25 px text scales to about 13: tiny.
        page = {
            "width": 1000,
            "regions": [row("a", (55, 0, 200, 300), bbox=(0, 0, 400, 300)), row("b", (0, 0, 100, 300), px=25)],
            "text_collisions": [["a", "b", 300, 0.2]],
        }
        boxes, review = predict_page(page, trigger="text")
        self.assertEqual(boxes, {})
        self.assertEqual(review[0]["reason"], "text would be tiny")
        # The same trim of 40 px text leaves about 20 px, not tiny: trimmed.
        page["regions"][1]["px"] = 40
        self.assertEqual(predict_page(page, trigger="text")[0], {"id-b": [0, 0, 55 - GAP_PX, 300]})

    def test_text_that_is_already_tiny_may_still_be_trimmed(self):
        page = {
            "width": 1000,
            "regions": [row("a", (0, 0, 200, 300)), row("b", (180, 0, 100, 300), px=10)],
            "text_collisions": [["a", "b", 300, 0.2]],
        }
        self.assertIn("id-b", predict_page(page, trigger="text")[0])

    def test_a_page_edited_by_hand_is_left_alone(self):
        page = {
            "hand_edited": True,
            "regions": [row("a", (0, 0, 200, 300)), row("b", (180, 0, 100, 300))],
            "text_collisions": [["a", "b", 300, 0.2]],
        }
        self.assertEqual(predict_page(page, trigger="text"), ({}, []))

    def test_the_box_trigger_also_trims_boxes_whose_text_does_not_collide(self):
        page = {"regions": [row("a", (0, 0, 200, 300)), row("b", (150, 0, 100, 300))], "text_collisions": []}
        self.assertEqual(predict_page(page, trigger="text")[0], {})
        self.assertIn("id-b", predict_page(page, trigger="box")[0])


if __name__ == "__main__":
    unittest.main()
