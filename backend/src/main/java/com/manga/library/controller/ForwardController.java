package com.manga.library.controller;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.RequestMapping;
import jakarta.servlet.http.HttpServletRequest;

@Controller
public class ForwardController {

    @RequestMapping(value = {
        "/{path:[^\\.]*}",
        "/**/{path:[^\\.]*}"
    })
    public String forward(HttpServletRequest request) {
        String path = request.getRequestURI();
        String contextPath = request.getContextPath();
        
        // Strip context path if present
        if (contextPath != null && !contextPath.isEmpty() && path.startsWith(contextPath)) {
            path = path.substring(contextPath.length());
        }
        
        // Exclude API paths so they don't get routed to index.html
        if (path.startsWith("/api")) {
            return "forward:/error";
        }
        
        return "forward:/index.html";
    }
}
