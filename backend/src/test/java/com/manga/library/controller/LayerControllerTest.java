package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;
import org.springframework.http.MediaType;
import java.util.Collections;
import com.manga.library.model.Image;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Layer;
import com.manga.library.model.LayerElement;
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

  @Test
  public void testGetLayerElementHistory_Success() throws Exception {
    UUID elementId = UUID.randomUUID();
    when(layerEditHistoryRepository.findByLayerElementIdOrderByEditedAtDesc(elementId))
        .thenReturn(Collections.emptyList());

    mockMvc
        .perform(get("/api/layer-elements/" + elementId + "/history"))
        .andExpect(status().isOk());
  }

  @Test
  public void testCreateLayer_Success() throws Exception {
    UUID imageId = UUID.randomUUID();
    Image image = Image.builder().id(imageId).filename("test.png").build();
    Layer layer = Layer.builder().id(UUID.randomUUID()).image(image).type("translation").build();

    when(imageRepository.findById(imageId)).thenReturn(Optional.of(image));
    when(layerRepository.save(any(Layer.class))).thenReturn(layer);

    mockMvc
        .perform(post("/api/images/" + imageId + "/layers")
            .contentType(MediaType.APPLICATION_JSON)
            .content("{\"type\": \"translation\"}"))
        .andExpect(status().isOk());
  }
}
