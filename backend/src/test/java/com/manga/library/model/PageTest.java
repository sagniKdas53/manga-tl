package com.manga.library.model;

import static org.junit.jupiter.api.Assertions.*;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class PageTest {

    @Test
    void testGettersAndSetters() {
        Page page = new Page();
        UUID id = UUID.randomUUID();
        page.setId(id);

        Chapter chapter = new Chapter();
        page.setChapter(chapter);

        page.setPageNumber(1);

        Image image = new Image();
        page.setImage(image);

        OffsetDateTime editedAt = OffsetDateTime.now();
        OffsetDateTime renderedAt = OffsetDateTime.now().plusHours(1);

        page.setLastEditedAt(editedAt);
        page.setLastRenderedAt(renderedAt);

        assertEquals(id, page.getId());
        assertEquals(chapter, page.getChapter());
        assertEquals(1, page.getPageNumber());
        assertEquals(image, page.getImage());
        assertEquals(editedAt, page.getLastEditedAt());
        assertEquals(renderedAt, page.getLastRenderedAt());
    }

    @Test
    void testEqualsAndHashCode() {
        UUID id1 = UUID.randomUUID();
        UUID id2 = UUID.randomUUID();

        Page p1 = new Page();
        p1.setId(id1);

        Page p2 = new Page();
        p2.setId(id1);

        Page p3 = new Page();
        p3.setId(id2);

        assertEquals(p1, p1);
        assertEquals(p1, p2);
        assertNotEquals(p1, p3);
        assertNotEquals(p1, null);
        assertNotEquals(p1, new Object());

        assertEquals(p1.hashCode(), p2.hashCode());
    }
}
