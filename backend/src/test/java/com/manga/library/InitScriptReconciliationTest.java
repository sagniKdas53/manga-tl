package com.manga.library;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * AUDIT-B5: {@code database/init.sql} (the production Postgres init script) and {@code
 * src/test/resources/init-test.sql} (the schema {@link SchemaValidationTest} validates entities
 * against via {@code ddl-auto: validate}) are two hand-maintained dumps with no mechanical link
 * between them. Nothing previously caught them drifting apart -- that is how {@code
 * images.reader_storage_path} landed in one and not the other. This loads both into a throwaway
 * Postgres, each in its own database, and diffs their column sets for every table both files
 * define.
 */
@Testcontainers
class InitScriptReconciliationTest {

  @Container
  @SuppressWarnings("resource")
  private static final PostgreSQLContainer<?> POSTGRES =
      new PostgreSQLContainer<>("postgres:15-alpine");

  // pg_dump's leading-backslash lines are psql-only meta-commands, not SQL, and OWNER TO names a
  // role (tladmin) this throwaway container never creates -- both are irrelevant to a
  // column-level diff, so strip rather than reproduce the production role setup.
  private static final Pattern STRIP_LINE =
      Pattern.compile("(?m)^(\\\\.*|ALTER TABLE .* OWNER TO .*;)\\s*$");

  @Test
  void productionInitSqlMatchesTestInitSql() throws Exception {
    Map<String, Set<String>> prodColumns = loadColumns("prod_init", resolveProductionInitSql());
    Map<String, Set<String>> testColumns = loadColumns("test_init", readClasspathResource("init-test.sql"));

    Set<String> sharedTables = new HashSet<>(prodColumns.keySet());
    sharedTables.retainAll(testColumns.keySet());
    assertThat(sharedTables)
        .as("tables present in both database/init.sql and init-test.sql")
        .isNotEmpty();

    for (String table : sharedTables) {
      assertThat(prodColumns.get(table))
          .as(
              "columns of table '%s': database/init.sql vs src/test/resources/init-test.sql",
              table)
          .isEqualTo(testColumns.get(table));
    }
  }

  private static String resolveProductionInitSql() throws IOException {
    Path path = Path.of("..", "database", "init.sql");
    assertThat(Files.exists(path))
        .as("database/init.sql must exist at %s", path.toAbsolutePath())
        .isTrue();
    return Files.readString(path, StandardCharsets.UTF_8);
  }

  private static String readClasspathResource(String resource) throws IOException {
    try (InputStream in =
        InitScriptReconciliationTest.class.getClassLoader().getResourceAsStream(resource)) {
      assertThat(in).as("classpath resource %s", resource).isNotNull();
      return new String(in.readAllBytes(), StandardCharsets.UTF_8);
    }
  }

  private static Map<String, Set<String>> loadColumns(String databaseName, String script)
      throws Exception {
    String sanitized = STRIP_LINE.matcher(script).replaceAll("");
    String baseUrl = "jdbc:postgresql://" + POSTGRES.getHost() + ":" + POSTGRES.getFirstMappedPort() + "/";

    try (Connection admin =
            DriverManager.getConnection(
                baseUrl + POSTGRES.getDatabaseName(), POSTGRES.getUsername(), POSTGRES.getPassword());
        Statement stmt = admin.createStatement()) {
      stmt.execute("CREATE DATABASE " + databaseName);
    }

    try (Connection conn =
            DriverManager.getConnection(baseUrl + databaseName, POSTGRES.getUsername(), POSTGRES.getPassword());
        Statement stmt = conn.createStatement()) {
      stmt.execute(sanitized);

      Map<String, Set<String>> columns = new TreeMap<>();
      try (ResultSet rs =
          stmt.executeQuery(
              "SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns "
                  + "WHERE table_schema = 'public' ORDER BY table_name, column_name")) {
        while (rs.next()) {
          String table = rs.getString("table_name");
          String column =
              rs.getString("column_name")
                  + ":"
                  + rs.getString("data_type")
                  + ":"
                  + rs.getString("is_nullable");
          columns.computeIfAbsent(table, key -> new TreeSet<>()).add(column);
        }
      }
      return columns;
    }
  }
}
