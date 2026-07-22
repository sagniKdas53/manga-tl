package com.manga.library.controller;

import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.manga.library.config.JwtAuthFilter;
import com.manga.library.model.Layer;
import com.manga.library.repository.ImageRepository;
import com.manga.library.repository.LayerEditHistoryRepository;
import com.manga.library.repository.LayerElementRepository;
import com.manga.library.repository.LayerRepository;
import com.manga.library.repository.OcrRegionRepository;
import java.util.Collections;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(LayerController.class)
@AutoConfigureMockMvc(addFilters = false)
@SuppressWarnings("null")
public class LayerControllerTest {

  @Autowired private MockMvc mockMvc;

  @MockBean private LayerRepository layerRepository;
  @MockBean private LayerElementRepository layerElementRepository;
  @MockBean private LayerEditHistoryRepository layerEditHistoryRepository;
  @MockBean private ImageRepository imageRepository;
  @MockBean private com.manga.library.repository.PageRepository pageRepository;
  @MockBean private OcrRegionRepository ocrRegionRepository;

  @MockBean private JwtAuthFilter jwtAuthFilter;

  @org.springframework.boot.test.mock.mockito.SpyBean
  private com.fasterxml.jackson.databind.ObjectMapper objectMapper;

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
    UUID pageId = UUID.randomUUID();
    com.manga.library.model.Page page = com.manga.library.model.Page.builder().id(pageId).build();
    Layer layer = Layer.builder().id(UUID.randomUUID()).page(page).type("translation").build();

    when(pageRepository.findById(pageId)).thenReturn(Optional.of(page));
    when(layerRepository.save(any(Layer.class))).thenReturn(layer);

    mockMvc
        .perform(
            post("/api/pages/" + pageId + "/layers")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"type\": \"translation\"}"))
        .andExpect(status().isOk());
  }


  @Test
  public void testUpdateLayerElement_Success() throws Exception {
    UUID elementId = UUID.randomUUID();
    com.manga.library.model.LayerElement element =
        com.manga.library.model.LayerElement.builder().id(elementId).text("old text").build();
    when(layerElementRepository.findById(elementId)).thenReturn(Optional.of(element));
    when(layerElementRepository.save(any())).thenReturn(element);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layer-elements/" + elementId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\": \"new text\"}"))
        .andExpect(status().isOk());
  }

  @Test
  public void testUpdateLayer_Success() throws Exception {
    UUID layerId = UUID.randomUUID();
    Layer layer = Layer.builder().id(layerId).zOrder(1).visible(true).build();
    when(layerRepository.findById(layerId)).thenReturn(Optional.of(layer));
    when(layerRepository.save(any(Layer.class))).thenReturn(layer);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layers/" + layerId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"zOrder\": 2, \"visible\": false}"))
        .andExpect(status().isOk());
  }

  @Test
  public void testCreateLayerElement_Success() throws Exception {
    UUID layerId = UUID.randomUUID();
    Layer layer = Layer.builder().id(layerId).build();
    when(layerRepository.findById(layerId)).thenReturn(Optional.of(layer));

    com.manga.library.model.LayerElement element =
        com.manga.library.model.LayerElement.builder().id(UUID.randomUUID()).layer(layer).build();
    when(layerElementRepository.save(any())).thenReturn(element);

    mockMvc
        .perform(
            post("/api/layers/" + layerId + "/elements")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\": \"hello\"}"))
        .andExpect(status().isOk());
  }

  @Test
  public void testDeleteLayerElement_Success() throws Exception {
    UUID elementId = UUID.randomUUID();
    com.manga.library.model.LayerElement element =
        com.manga.library.model.LayerElement.builder().id(elementId).build();
    when(layerElementRepository.findById(elementId)).thenReturn(Optional.of(element));

    mockMvc.perform(delete("/api/layer-elements/" + elementId)).andExpect(status().isOk());

    verify(layerElementRepository, times(1)).delete(element);
  }

  @Test
  public void testUpdateLayerElement_NotFound() throws Exception {
    UUID elementId = UUID.randomUUID();
    when(layerElementRepository.findById(elementId)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layer-elements/" + elementId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{}"))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testUpdateLayerElement_Exception() throws Exception {
    UUID elementId = UUID.randomUUID();
    com.manga.library.model.LayerElement element =
        com.manga.library.model.LayerElement.builder().id(elementId).text("old text").build();
    when(layerElementRepository.findById(elementId)).thenReturn(Optional.of(element));

    doThrow(new RuntimeException("JSON error")).when(objectMapper).writeValueAsString(any());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layer-elements/" + elementId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\": \"new text\"}"))
        .andExpect(status().isInternalServerError());
  }

  @Test
  public void testCreateLayer_NotFound() throws Exception {
    UUID pageId = UUID.randomUUID();
    when(pageRepository.findById(pageId)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            post("/api/pages/" + pageId + "/layers")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"type\": \"translation\"}"))
        .andExpect(status().isNotFound());
  }


  @Test
  public void testUpdateLayer_NotFound() throws Exception {
    UUID layerId = UUID.randomUUID();
    when(layerRepository.findById(layerId)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layers/" + layerId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"zOrder\": 2}"))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testCreateLayerElement_NotFound() throws Exception {
    UUID layerId = UUID.randomUUID();
    when(layerRepository.findById(layerId)).thenReturn(Optional.empty());

    mockMvc
        .perform(
            post("/api/layers/" + layerId + "/elements")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\": \"hello\"}"))
        .andExpect(status().isNotFound());
  }

  @Test
  public void testDeleteLayerElement_NotFound() throws Exception {
    UUID elementId = UUID.randomUUID();
    when(layerElementRepository.findById(elementId)).thenReturn(Optional.empty());

    mockMvc.perform(delete("/api/layer-elements/" + elementId)).andExpect(status().isNotFound());
  }

  @Test
  public void testUpdateLayerElement_WithParentLayerMetadata() throws Exception {
    UUID elementId = UUID.randomUUID();
    com.fasterxml.jackson.databind.node.ObjectNode metadata =
        new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
    metadata.put("foo", "bar");

    Layer parentLayer = Layer.builder().id(UUID.randomUUID()).metadataJson(metadata).build();
    com.manga.library.model.LayerElement element =
        com.manga.library.model.LayerElement.builder()
            .id(elementId)
            .layer(parentLayer)
            .text("old text")
            .build();

    when(layerElementRepository.findById(elementId)).thenReturn(Optional.of(element));
    when(layerElementRepository.save(any())).thenReturn(element);
    when(layerRepository.save(any())).thenReturn(parentLayer);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layer-elements/" + elementId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"text\": \"new text\"}"))
        .andExpect(status().isOk());

    verify(layerRepository, times(1)).save(parentLayer);
  }

  @Test
  public void testCreateLayer_MetadataAndDoubleZOrder() throws Exception {
    UUID pageId = UUID.randomUUID();
    com.manga.library.model.Page page = com.manga.library.model.Page.builder().id(pageId).build();
    Layer layer = Layer.builder().id(UUID.randomUUID()).page(page).type("translation").build();

    when(pageRepository.findById(pageId)).thenReturn(Optional.of(page));
    when(layerRepository.save(any(Layer.class))).thenReturn(layer);

    mockMvc
        .perform(
            post("/api/pages/" + pageId + "/layers")
                .contentType(MediaType.APPLICATION_JSON)
                .content(
                    "{\"type\": \"translation\", \"zOrder\": 2.5, \"metadataJson\": {\"foo\":"
                        + " \"bar\"}}"))
        .andExpect(status().isOk());
  }


  @Test
  public void testUpdateLayer_DoubleZOrder() throws Exception {
    UUID layerId = UUID.randomUUID();
    Layer layer = Layer.builder().id(layerId).zOrder(1).visible(true).build();
    when(layerRepository.findById(layerId)).thenReturn(Optional.of(layer));
    when(layerRepository.save(any(Layer.class))).thenReturn(layer);

    mockMvc
        .perform(
            org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put(
                    "/api/layers/" + layerId)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"zOrder\": 3.5, \"visible\": false}"))
        .andExpect(status().isOk());
  }
}
