package com.manga.library.model;

import static org.junit.jupiter.api.Assertions.*;

import java.time.OffsetDateTime;
import org.junit.jupiter.api.Test;

class SystemSettingTest {

    @Test
    void testGettersAndSetters() {
        SystemSetting setting = new SystemSetting();
        setting.setSettingKey("key");
        setting.setSettingValue("val");

        OffsetDateTime now = OffsetDateTime.now();
        setting.setUpdatedAt(now);

        assertEquals("key", setting.getSettingKey());
        assertEquals("val", setting.getSettingValue());
        assertEquals(now, setting.getUpdatedAt());
    }

    @Test
    void testEqualsAndHashCode() {
        SystemSetting s1 = new SystemSetting();
        s1.setSettingKey("k1");

        SystemSetting s2 = new SystemSetting();
        s2.setSettingKey("k1");

        SystemSetting s3 = new SystemSetting();
        s3.setSettingKey("k2");

        assertEquals(s1, s1);
        assertEquals(s1, s2);
        assertNotEquals(s1, s3);
        assertNotEquals(s1, null);
        assertNotEquals(s1, new Object());

        assertEquals(s1.hashCode(), s2.hashCode());
    }

    @Test
    void testOnUpdate() {
        SystemSetting setting = new SystemSetting();
        setting.onUpdate();
        assertNotNull(setting.getUpdatedAt());
    }
}
