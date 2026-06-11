package com.manga.library;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.manga.library.dto.ChapterDto;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultHandlers.print;

@SpringBootTest
@AutoConfigureMockMvc
public class JwtTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    public void testPostChapter() throws Exception {
        ChapterDto dto = new ChapterDto();
        dto.setChapterNumber(1);
        dto.setTitle("One");

        String token = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJscjh0aHhoNXVAbW96bWFpbC5jb20iLCJpYXQiOjE3ODEyMDUyNTQsImV4cCI6MTc4MTI5MTY1NH0.Oql6msIgRsUkkdOaQ93hXB2d9bH6ptQxQIs-j3pBgGs";

        mockMvc.perform(post("/api/series/0672051f-9264-4d57-878b-d208e59a8326/chapters")
                .header("Authorization", token)
                .contentType(MediaType.APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(dto)))
                .andDo(print());
    }
}
