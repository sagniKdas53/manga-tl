# More Observations

- [ ] About the SSE pause/resume, individual jobs too can have pause/resume like say 20 jobs but I paused 2nd one, 19 others should still get processed
  - [ ] just make sure we are not forgetting about job level control in the new sse pause/resume
- [ ] target backend: failed to solve: maven:3-eclipse-temurin-26: failed to resolve source metadata for docker.io/library/maven:3-eclipse-temurin-26: failed to do request: Head "<https://registry-1.docker.io/v2/library/maven/manifests/3-eclipse-temurin-26>": dial tcp: lookup registry-1.docker.io: no such host
  - [ ] We are still on java 17 on the local system (while back ward compatible we need to make sure that version mismatch isn't an issue)
  - [ ] Look at [upgrade plan](../docs/java-upgrade-plan.md) for the plan to use stable LTS locally while still keeping the java 26 on dokker
- [ ] I simulated that failure scenario where job retry should work
  - [ ] It works on the worker as seen in the logs [retry logs](../logs/run-13-retry-check.log)
  - [ ] On the front-end the [retry count](../examples/the-retry-count-never-updated.png) never updated
  - [ ] I suspect that because the retries happen on the workers so the back-end never knows about it and so the front end is never sent any info
  - [ ] Also it seems like, after a few retries it does indded used the default model to do the TL, the QA is skipped for some reason instead of using the default model, which is what we want (as a fallback)
- [ ] I want you to inceorporate this into the improvement plan as well
  - [ ] Move Thumbnail Generation Off the Upload Request Path

          > [!IMPORTANT]
          > **Q: Will the WebP + bicubic change make thumbnailing fast enough to not slow the upload down?**
          > No — the bottleneck isn't the encode format, it's the **full-resolution decode + 2 sequential MinIO round trips** that block the servlet thread. A 5000×7000 image = 105-140 MB `BufferedImage` in heap just for thumbnailing. With 200 concurrent uploads (Tomcat default), this risks OOM and thread-pool starvation. Batch imports are worst case — one request thread pinned for minutes in a per-file loop.

          **Files**: `PageService.java`, `PageController.java`, `SeriesController.java`

          **Current flow** (synchronous, blocking):

          ```
          Upload → file.getBytes() → ImageIO.read (full decode) → bilinear resize → ImageIO.write(jpg)
                → MinIO.put(original) → MinIO.put(thumbnail) → HTTP response → startPipeline()
          ```

          **Proposed flow** (async, non-blocking):

          ```
          Upload → file.getBytes() → MinIO.put(original) → HTTP response → startPipeline()
                                                                          ↳ @Async thumbnailPool:
                                                                            ImageReader.subsampled()
                                                                            → bicubic resize → WebP
                                                                            → MinIO.put(thumbnail)
                                                                            → update Image.thumbnailStoragePath
          ```

          - Use `ImageReader` subsampling to avoid full-resolution decode (read at 1/4 or 1/8 scale directly)
          - Create a bounded `@Async` thread pool (`thumbnailExecutor`, size 2-4)
          - `Image.thumbnailStoragePath` starts as `null`; thumbnail endpoint returns a placeholder/original until ready
          - For batch imports (`importProject`/`importChapter`): queue all thumbnails to the async pool instead of blocking per-file
          - Existing behavior is already resilient: thumbnail failure doesn't block upload (lines 546-548)```

- [ ] As for the UI/UX changes I have done a bit of digging
  - [ ] I have taken a screens shot of how nHentai handled user profile edits ![user-profile](../examples/nHentai/user-setting-page.png) now we don't need everything but we can definitely add some things form here like the Profile with Avatars about (we don't need favourite tags), see they too don't allow email change but a password change is allowed
  - [ ] Next we don't need the blocked tags
  - [ ] Add the API keys as a stretch goal (keep the design as a stub)
  - [ ] Sessions and delete profile can be added too
  - [ ] Next I have extracted the palette so we can use it for our dark mode see ![nhentai-palette](../examples/nHentai/Screenshot%202026-07-12%20at%2014-09-52%20Site%20Palette%20🎨.png)
  - [ ] Next for the chapters and series pages since we don't do pageination like nHentai see ![pagenination](../examples/nHentai/add-paged-navigation-as-the-library-can-big.png) we can add lazy loading so that when user scrolls down we can load in more series chapters and pages
  - [ ] For the light mode only use the palette from pixiv don't copy their design it's not good enough ![pixiv-palette](../examples/pixiv/Screenshot%202026-07-12%20at%2014-11-16%20Site%20Palette%20🎨.png)
- [ ] In the plan-imorvements add sections to upgrade the yolo models, or improve the prompts for each stage of the pipeline.
  