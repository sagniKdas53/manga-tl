package com.manga.library.controller;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.server.ResponseStatusException;

/**
 * Catch-all for paths no other controller claims: the SPA's client-side routes get
 * {@code index.html}, and anything under {@code /api} gets a 404.
 */
@Controller
public class ForwardController {

  @RequestMapping(value = {"/{path:[^\\.]*}", "/**/{path:[^\\.]*}"})
  public String forward(HttpServletRequest request) {
    String path = request.getRequestURI();
    String contextPath = request.getContextPath();

    // Strip context path if present
    if (contextPath != null && !contextPath.isEmpty() && path.startsWith(contextPath)) {
      path = path.substring(contextPath.length());
    }

    // An unmatched API path is a 404, not a page. This used to be `forward:/error`, which
    // does reach the error controller but leaves the status at 200 — nothing sets
    // `jakarta.servlet.error.status_code` on a plain forward, so callers got an error body
    // under a success status and any client checking `res.ok` first read it as success.
    if (path.startsWith("/api")) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND);
    }

    return "forward:/index.html";
  }
}
