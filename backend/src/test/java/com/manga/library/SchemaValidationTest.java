package com.manga.library;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.persistence.EntityManager;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;

@SpringBootTest
@ActiveProfiles("integration")
@Import(TestcontainersConfig.class)
public class SchemaValidationTest {

  @Autowired private EntityManager entityManager;

  @Test
  void contextLoads_withRealPostgresSchema() {
    assertThat(entityManager).isNotNull();
  }

  @Test
  void allTablesExist_andHavePrimaryKeys() {
    @SuppressWarnings("unchecked")
    List<String> tableNames =
        entityManager
            .createNativeQuery(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")
            .getResultList();

    assertThat(tableNames)
        .contains(
            "users",
            "series",
            "chapters",
            "images",
            "pages",
            "layers",
            "ocr_regions",
            "layer_elements");

    for (String table : tableNames) {
      @SuppressWarnings("unchecked")
      List<Object> pkCount =
          entityManager
              .createNativeQuery(
                  "SELECT count(*) FROM information_schema.table_constraints "
                      + "WHERE table_schema = 'public' AND table_name = :tableName AND constraint_type = 'PRIMARY KEY'")
              .setParameter("tableName", table)
              .getResultList();

      assertThat(((Number) pkCount.get(0)).longValue())
          .as("Table %s must have a primary key", table)
          .isGreaterThan(0);
    }
  }
}
