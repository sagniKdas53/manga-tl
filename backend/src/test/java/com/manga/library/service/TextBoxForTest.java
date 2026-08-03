package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.OcrRegion;
import org.junit.jupiter.api.Test;

/**
 * Geometry of the translated text box.
 *
 * <p>Two rules, and they pull in opposite directions.
 *
 * <p><b>With a detected bubble</b> the box must sit <em>inside</em> the outline. The geometry before
 * f3aa160 grew {@code safeText} outward by 20px per axis, and since {@code safeText} measures 95-97%
 * of the bubble on regions that have one, that put the text box outside the outline.
 *
 * <p><b>Without a detected bubble</b> the box must grow <em>outward</em>. The worker still populates
 * {@code bubble*} for free-floating text, but from the OCR bbox itself — so the "bubble" is the tight
 * vertical Japanese column and insetting it produces a box narrower than a single English word.
 */
class TextBoxForTest {

  /** A region with a real detected bubble: the bubble is strictly larger than the text bbox. */
  private static OcrRegion bubbleRegion(int bx, int by, int bw, int bh) {
    OcrRegion r = new OcrRegion();
    r.setBubbleId("bubble_0");
    r.setBubbleX(bx);
    r.setBubbleY(by);
    r.setBubbleW(bw);
    r.setBubbleH(bh);
    // The text sits well inside the bubble, as it does whenever detection actually fired.
    r.setBboxX(bx + bw / 4);
    r.setBboxY(by + bh / 4);
    r.setBboxW(bw / 2);
    r.setBboxH(bh / 2);
    return r;
  }

  /** A free-floating region: the worker copies bubble* from the text bbox and tags it direct_text. */
  private static OcrRegion directTextRegion(int x, int y, int w, int h) {
    OcrRegion r = new OcrRegion();
    r.setBubbleId("direct_text_0");
    r.setBubbleX(x);
    r.setBubbleY(y);
    r.setBubbleW(w);
    r.setBubbleH(h);
    r.setBboxX(x);
    r.setBboxY(y);
    r.setBboxW(w);
    r.setBboxH(h);
    r.setSafeTextX(x);
    r.setSafeTextY(y);
    r.setSafeTextW(w);
    r.setSafeTextH(h);
    return r;
  }

  @Test
  void insetsInsideTheBubbleRatherThanGrowingPastIt() {
    JobCoordinatorService.TextBox box =
        JobCoordinatorService.textBoxFor(bubbleRegion(100, 200, 300, 400));

    assertEquals(110.0, box.x());
    assertEquals(210.0, box.y());
    assertEquals(280, box.w());
    assertEquals(380, box.h());
    // The box must not extend beyond the bubble on any edge.
    assertTrue(box.x() >= 100, "left edge inside bubble");
    assertTrue(box.y() >= 200, "top edge inside bubble");
    assertTrue(box.x() + box.w() <= 400, "right edge inside bubble");
    assertTrue(box.y() + box.h() <= 600, "bottom edge inside bubble");
  }

  @Test
  void usesBubbleWidthNotTheVerticalJapaneseTextExtent() {
    OcrRegion r = bubbleRegion(0, 0, 300, 200);
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
    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(bubbleRegion(5, 5, 30, 18));

    assertTrue(box.w() > 0 && box.h() > 0, "must never invert to zero or negative");
    assertEquals(30, box.w());
    assertEquals(18, box.h());
  }

  /**
   * The f3aa160 regression. Page 22 of Openrouter ch. 11: a 49x489 caption in an irregular thought
   * cloud the detector never matched. Insetting took it to 29px — narrower than "going" at any
   * legible size — and the renderer fell through to per-character splitting.
   */
  @Test
  void growsFreeFloatingTextOutwardInsteadOfInsettingItIntoNothing() {
    JobCoordinatorService.TextBox box =
        JobCoordinatorService.textBoxFor(directTextRegion(71, 675, 49, 489));

    assertEquals(69, box.w(), "must grow past the 49px source column, not shrink below it");
    assertEquals(509, box.h());
    assertEquals(61.0, box.x());
    assertEquals(665.0, box.y());
  }

  /** Rows written before bubbleId existed are caught by the geometry, not the tag. */
  @Test
  void treatsBubbleGeometryIdenticalToTheBboxAsNoBubbleAtAll() {
    OcrRegion untagged = directTextRegion(1050, 631, 57, 428);
    untagged.setBubbleId(null);

    assertEquals(77, JobCoordinatorService.textBoxFor(untagged).w());
  }

  /**
   * The worker's contour fallback can supply a real container for a region YOLO matched to no
   * bubble. It stays tagged {@code direct_text_*}, so the tag must not be what decides this.
   */
  @Test
  void insetsAContourRecoveredBubbleEvenThoughItIsStillTaggedDirectText() {
    OcrRegion recovered = directTextRegion(71, 675, 49, 489);
    // Contour found the thought cloud: ~2.6x wider than the text column it contains.
    recovered.setBubbleX(30);
    recovered.setBubbleY(640);
    recovered.setBubbleW(127);
    recovered.setBubbleH(560);

    JobCoordinatorService.TextBox box = JobCoordinatorService.textBoxFor(recovered);

    assertEquals(107, box.w(), "inset into the recovered bubble, not grown past it");
    assertEquals(540, box.h());
    assertTrue(box.x() >= 30 && box.x() + box.w() <= 157, "stays within the recovered bubble");
  }

  /**
   * Absent bubble geometry is the same situation as synthetic bubble geometry: {@code safeText} and
   * {@code bbox} are both tight text extents, not containers, so both grow rather than inset.
   */
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
    assertEquals(220, box.w(), "safeText preferred over bbox when bubble is absent");
    assertEquals(40.0, box.x());

    OcrRegion bboxOnly = new OcrRegion();
    bboxOnly.setBboxX(10);
    bboxOnly.setBboxY(10);
    bboxOnly.setBboxW(120);
    bboxOnly.setBboxH(120);

    assertEquals(140, JobCoordinatorService.textBoxFor(bboxOnly).w());
  }

  @Test
  void neverPositionsOffTheTopLeftOfTheImage() {
    assertTrue(JobCoordinatorService.textBoxFor(bubbleRegion(0, 0, 200, 200)).x() >= 0);
    assertTrue(JobCoordinatorService.textBoxFor(bubbleRegion(0, 0, 200, 200)).y() >= 0);
    // Free-floating text grows outward, so it is the case that can go negative.
    assertTrue(JobCoordinatorService.textBoxFor(directTextRegion(0, 0, 200, 200)).x() >= 0);
    assertTrue(JobCoordinatorService.textBoxFor(directTextRegion(0, 0, 200, 200)).y() >= 0);
  }
}
