package com.manga.library;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class MangaLibraryApplication {
  public static void main(String[] args) {
    SpringApplication.run(MangaLibraryApplication.class, args);
  }
}
