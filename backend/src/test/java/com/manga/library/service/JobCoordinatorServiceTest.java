package com.manga.library.service;

import static org.junit.jupiter.api.Assertions.*;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.util.ReflectionTestUtils;

@SpringBootTest
public class JobCoordinatorServiceTest {

  @Autowired private JobCoordinatorService jobCoordinatorService;

  private HttpServer testServer;
  private int testPort;
  private String originalUrl;

  @BeforeEach
  public void setUp() throws IOException {
    originalUrl = (String) ReflectionTestUtils.getField(jobCoordinatorService, "workerHealthUrl");
    testServer = HttpServer.create(new InetSocketAddress(0), 0);
    testPort = testServer.getAddress().getPort();
    testServer.start();
  }

  @AfterEach
  public void tearDown() {
    if (testServer != null) {
      testServer.stop(0);
    }
    ReflectionTestUtils.setField(jobCoordinatorService, "workerHealthUrl", originalUrl);
  }

  @Test
  public void testIsWorkerHealthy_Healthy() {
    testServer.createContext(
        "/health",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{\"status\":\"healthy\",\"redis\":\"connected\"}";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertTrue(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_HealthyWithSpaces() {
    testServer.createContext(
        "/health-spaces",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{ \"status\": \"healthy\", \"redis\": \"connected\" }";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService,
        "workerHealthUrl",
        "http://localhost:" + testPort + "/health-spaces");
    assertTrue(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_UnhealthyStatus() {
    testServer.createContext(
        "/health",
        new HttpHandler() {
          @Override
          public void handle(HttpExchange exchange) throws IOException {
            String response = "{\"status\":\"unhealthy\",\"redis\":\"disconnected\"}";
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(500, response.length());
            try (OutputStream os = exchange.getResponseBody()) {
              os.write(response.getBytes());
            }
          }
        });

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertFalse(jobCoordinatorService.isWorkerHealthy());
  }

  @Test
  public void testIsWorkerHealthy_Offline() {
    testServer.stop(0);
    testServer = null;

    ReflectionTestUtils.setField(
        jobCoordinatorService, "workerHealthUrl", "http://localhost:" + testPort + "/health");
    assertFalse(jobCoordinatorService.isWorkerHealthy());
  }
}
