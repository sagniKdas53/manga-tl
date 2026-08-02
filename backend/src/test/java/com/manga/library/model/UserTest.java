package com.manga.library.model;

import static org.junit.jupiter.api.Assertions.*;

import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class UserTest {

    @Test
    void testGettersAndSetters() {
        User user = new User();
        UUID id = UUID.randomUUID();
        user.setId(id);
        user.setEmail("test@test.com");
        user.setPasswordHash("hash");
        user.setDisplayName("Test User");
        user.setRole("admin");

        OffsetDateTime now = OffsetDateTime.now();
        user.setCreatedAt(now);

        assertEquals(id, user.getId());
        assertEquals("test@test.com", user.getEmail());
        assertEquals("hash", user.getPasswordHash());
        assertEquals("Test User", user.getDisplayName());
        assertEquals("admin", user.getRole());
        assertEquals(now, user.getCreatedAt());
    }

    @Test
    void testEqualsAndHashCode() {
        UUID id1 = UUID.randomUUID();
        UUID id2 = UUID.randomUUID();

        User u1 = new User();
        u1.setId(id1);

        User u2 = new User();
        u2.setId(id1);

        User u3 = new User();
        u3.setId(id2);

        assertEquals(u1, u1);
        assertEquals(u1, u2);
        assertNotEquals(u1, u3);
        assertNotEquals(u1, null);
        assertNotEquals(u1, new Object());

        assertEquals(u1.hashCode(), u2.hashCode());
    }

    @Test
    void testOnCreate() {
        User user = new User();
        user.onCreate();
        assertNotNull(user.getCreatedAt());
    }
}
