package com.manga.library.repository;

import static org.junit.jupiter.api.Assertions.*;

import com.manga.library.model.*;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase;
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest;
import org.springframework.test.context.ActiveProfiles;

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@ActiveProfiles("test")
public class LayerElementRepositoryTest {

  @Autowired private LayerElementRepository layerElementRepository;
  @Autowired private LayerRepository layerRepository;
  @Autowired private ImageRepository imageRepository;

  @Test
  public void testLayerElementCRUD() {
    // Parent Image and Layer
    Image image = Image.builder().filename("el_img.png").storagePath("path/el_img.png").build();
    image = imageRepository.save(image);

    Layer layer = Layer.builder().image(image).type("translation").build();
    layer = layerRepository.save(layer);

    // 1. Create
    LayerElement element =
        LayerElement.builder()
            .layer(layer)
            .text("Hello World")
            .font("Arial")
            .size(14.0)
            .x(100.0)
            .y(200.0)
            .visible(true)
            .build();

    LayerElement saved = layerElementRepository.save(element);
    assertNotNull(saved.getId());
    assertEquals("Hello World", saved.getText());
    assertEquals("Arial", saved.getFont());
    assertEquals(14.0, saved.getSize());
    assertEquals(100.0, saved.getX());
    assertEquals(200.0, saved.getY());
    assertTrue(saved.getVisible());
    assertEquals(layer.getId(), saved.getLayer().getId());

    // 2. Read
    Optional<LayerElement> fetchedOpt = layerElementRepository.findById(saved.getId());
    assertTrue(fetchedOpt.isPresent());
    LayerElement fetched = fetchedOpt.get();
    assertEquals("Hello World", fetched.getText());

    // 3. Update
    fetched.setText("Goodbye World");
    fetched.setX(150.0);
    LayerElement updated = layerElementRepository.save(fetched);
    assertEquals("Goodbye World", updated.getText());
    assertEquals(150.0, updated.getX());

    // 4. Delete
    layerElementRepository.delete(updated);
    layerElementRepository.flush();

    Optional<LayerElement> deleted = layerElementRepository.findById(saved.getId());
    assertTrue(deleted.isEmpty());
  }
}
