package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.OcrRegion;
import org.junit.jupiter.api.Test;

/**
 * Geometry of the translated text box.
 *
 * <p>The rule that matters: the box must sit <em>inside</em> the bubble. The previous geometry grew
 * {@code safeText} outward by 20px per axis, and since {@code safeText} measured 97-98% of the
 * bubble across this library, that put the text box outside the outline.
 */
class TextBoxForTest {

  private static OcrRegion region(int bx, int by, int bw, int bh) {
    OcrRegion r = new OcrRegion();
    r.setBubbleX(bx);
    r.setBubbleY(by);
    r.setBubbleW(bw);
    r.setBubbleH(bh);
    r.setBboxX(bx);
    r.setBboxY(by);
    r.setBboxW(bw);
    r.setBboxH(bh);
    return r;
  }

  @Test
  void insetsInsideTheBubbleRatherThanGrowingPastIt() {
    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(region(100, 200, 300, 400));

    assertEquals(110.0, box.x());
    assertEquals(210.0, box.y());
    assertEquals(280, box.w());
    assertEquals(260, box.h() - 120);
    // The box must not extend beyond the bubble on any edge.
    assertTrue(box.x() >= 100, "left edge inside bubble");
    assertTrue(box.x() + box.w() <= 400, "right edge inside bubble");
    assertTrue(box.y() + box.h() <= 600, "bottom edge inside bubble");
  }

  @Test
  void usesBubbleWidthNotTheVerticalJapaneseTextExtent() {
    OcrRegion r = region(0, 0, 300, 200);
    // safeText traces the source text: tall and narrow, the shape English should not inherit.
    r.setSafeTextX(120);
    r.setSafeTextY(10);
    r.setSafeTextW(60);
    r.setSafeTextH(180);

    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(r);

    assertEquals(280, box.w(), "should take the bubble's width, not safeText's 60");
    assertTrue(box.w() > box.h(), "a wide bubble should yield a wide text box");
  }

  @Test
  void tinyBubbleKeepsItsExtentInsteadOfCollapsing() {
    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(region(5, 5, 30, 18));

    assertTrue(box.w() > 0 && box.h() > 0, "must never invert to zero or negative");
    assertEquals(30, box.w());
    assertEquals(18, box.h());
  }

  @Test
  void fallsBackToSafeTextThenBboxWhenBubbleGeometryIsMissing() {
    OcrRegion noBubble = new OcrRegion();
    noBubble.setSafeTextX(50);
    noBubble.setSafeTextY(60);
    noBubble.setSafeTextW(200);
    noBubble.setSafeTextH(100);
    noBubble.setBboxX(0);
    noBubble.setBboxY(0);
    noBubble.setBboxW(999);
    noBubble.setBboxH(999);

    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(noBubble);
    assertEquals(180, box.w(), "safeText preferred over bbox when bubble is absent");

    OcrRegion bboxOnly = new OcrRegion();
    bboxOnly.setBboxX(10);
    bboxOnly.setBboxY(10);
    bboxOnly.setBboxW(120);
    bboxOnly.setBboxH(120);

    assertEquals(100, JobCoordinatorService.textBoxFor(bboxOnly).w());
  }

  @Test
  void neverPositionsOffTheTopLeftOfTheImage() {
    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(region(0, 0, 200, 200));

    assertTrue(box.x() >= 0);
    assertTrue(box.y() >= 0);
  }
}
