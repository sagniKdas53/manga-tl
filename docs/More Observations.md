# More Observations

- [ ] About the SSE pause/resume, individual jobs too can have pause/resume like say 20 jobs but I paused 2nd one, 19 others should still get processed
  - [ ] just make sure we are not forgetting about job level control in the new sse pause/resume
- [ ] target backend: failed to solve: maven:3-eclipse-temurin-26: failed to resolve source metadata for docker.io/library/maven:3-eclipse-temurin-26: failed to do request: Head "<https://registry-1.docker.io/v2/library/maven/manifests/3-eclipse-temurin-26>": dial tcp: lookup registry-1.docker.io: no such host
  - [ ] We are still on java 17 on the local system (while back ward compatible we need to make sure that version mismatch isn't an issue)
- [ ] I simulated that failure scenario where job retry should work
  - [ ] It works on the worker as seen in the logs [retry logs](../logs/run-13-retry-check.log)
  - [ ] On the front-end the [retry count](../examples/the-retry-count-never-updated.png) never updated
  - [ ] I suspect that because the retries happen on the workers so the back-end never knows about it and so the front end is never sent any info
  - [ ] Also it seems like, after a few retries it does indded used the default model to do the TL, the QA is skipped for some reason instead of using the default model, which is what we want (as a fallback)
  