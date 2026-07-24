import { z } from 'zod';

// We can derive Zod schemas from our TypeScript definitions if we want runtime checks,
// but for now we manually define the most critical boundaries as requested.

export const PageDtoSchema = z.object({
  id: z.string().uuid(),
  pageNumber: z.number().int(),
  imageId: z.string().uuid(),
  chapterId: z.string().uuid(),
  filename: z.string(),
  url: z.string(),
  thumbnailUrl: z.string().optional().nullable(),
});

export const ProblemDetailSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().optional(),
  instance: z.string().optional(),
});

export const SseProgressEventSchema = z.object({
  jobId: z.string().uuid(),
  progress: z.number(),
  status: z.string(),
  message: z.string().optional(),
});

export const SseCompletionEventSchema = z.object({
  jobId: z.string().uuid(),
  status: z.literal("COMPLETED"),
  result: z.any().optional(),
});
