import { describe, it, expect } from "vitest";
import {
  PageDtoSchema,
  ProblemDetailSchema,
  SseProgressEventSchema,
  SseCompletionEventSchema,
} from "../../api/schemas";

describe("API Contract Schemas", () => {
  it("PageDtoSchema parses valid page dto", () => {
    const validPage = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      pageNumber: 1,
      imageId: "123e4567-e89b-12d3-a456-426614174001",
      chapterId: "123e4567-e89b-12d3-a456-426614174002",
      filename: "001.png",
      url: "/api/images/123e4567-e89b-12d3-a456-426614174001/file",
    };
    expect(PageDtoSchema.parse(validPage)).toEqual(validPage);
  });

  it("ProblemDetailSchema parses problem detail", () => {
    const problem = {
      status: 404,
      title: "Not Found",
      detail: "Page not found",
    };
    expect(ProblemDetailSchema.parse(problem)).toEqual(problem);
  });

  it("SseProgressEventSchema parses progress event", () => {
    const event = {
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      progress: 50.0,
      status: "PROCESSING",
      message: "OCR processing page 1",
    };
    expect(SseProgressEventSchema.parse(event)).toEqual(event);
  });

  it("SseCompletionEventSchema parses completion event", () => {
    const event = {
      jobId: "123e4567-e89b-12d3-a456-426614174000",
      status: "COMPLETED" as const,
    };
    expect(SseCompletionEventSchema.parse(event)).toEqual(event);
  });
});
