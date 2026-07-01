package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Layer;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.LayerEditHistoryRepository;
import com.manga.library.repository.LayerElementRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.OcrRegionRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(LayerController.class)
@AutoConfigureMockMvc(addFilters = false)
public class LayerControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private LayerRepository layerRepository;
  @MockBean private LayerElementRepository layerElementRepository;
  @MockBean private LayerEditHistoryRepository layerEditHistoryRepository;
  @MockBean private ImageRepository imageRepository;
  @MockBean private OcrRegionRepository ocrRegionRepository;
  @MockBean private JwtAuthFilter jwtAuthFilter;

  @Test
  public void testDeleteLayer_NotFound() throws Exception {
    UUID layerId = UUID.randomUUID();
    when(layerRepository.findById(layerId)).thenReturn(Optional.empty());

    mockMvc.perform(delete("/api/layers/" + layerId)).andExpect(status().isNotFound());
  }

  @Test
  public void testDeleteLayer_Success() throws Exception {
    UUID layerId = UUID.randomUUID();
    Layer layer = Layer.builder().id(layerId).build();
    when(layerRepository.findById(layerId)).thenReturn(Optional.of(layer));

    mockMvc.perform(delete("/api/layers/" + layerId)).andExpect(status().isOk());

    verify(layerRepository, times(1)).delete(layer);
  }
}
