# Issues and What I want for them

## CI failing

### Build and test backend

```log
[INFO] Recompiling the module because of changed source code.
[INFO] Compiling 78 source files with javac [debug parameters release 25] to target/classes
[INFO] ------------------------------------------------------------------------
[INFO] BUILD FAILURE
[INFO] ------------------------------------------------------------------------
[INFO] Total time:  12.738 s
[INFO] Finished at: 2026-07-30T03:54:02Z
[INFO] ------------------------------------------------------------------------
[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile (default-compile) on project library: Fatal error compiling: error: release version 25 not supported -> [Help 1]
[ERROR] 
[ERROR] To see the full stack trace of the errors, re-run Maven with the -e switch.
[ERROR] Re-run Maven using the -X switch to enable full debug logging.
[ERROR] 
[ERROR] For more information about the errors and possible solutions, please read the following articles:
[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoExecutionException
Error: Process completed with exit code 1.
```

### Install, lint, and build frontend

```log
⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 39 passed (40)
      Tests  1 failed | 248 passed | 1 skipped (250)
   Start at  03:53:57
   Duration  49.67s (transform 1.86s, setup 4.98s, import 21.88s, tests 61.75s, environment 42.70s)


Error: AssertionError: expected false to be true // Object.is equality
```

## Same image handling had not worked for a long time now

Idea [duplicate_handling](./duplicate_handling.md)

## The queue manangemt has become absolute shit

It takes 2 hours to process 50 images, just check the logs.

Log in question [run-3-fresh.log](../logs/run-3-fresh.log) for details.

Atlest the OCR which has a deidated slot as described in [slot_allocation](./slot_allocation.md) should have been prioritized and completed.

Also check if the queue docs are upto date [queue_management_system](./translation_pipeline_phases.md) and if there are any optimizations not yet uncovered.

Check out the provider intgeration guide as well [workers_providers](./worker_provider_integration.md) same idea check if outdated and update also check for optimizations, I believe this was created before the `providers.json` was added so more likely outdated.

## The UI is laggy and loads slow

General observation, will do a proper firefox profile analysis later.

Most probably the backend holding it back, but it's probably just the inhertiatnace and overrides + the logic bugs.

## Add an export rendered PNG button

See: ![image](./Add_an_export_rendered_PNG_button.png)

---

## Add Free Provider for Testing

[uncloseai](https://uncloseai.com/python-examples.html)
also [free-ollama](https://github.com/mfoud444/ollamafreeapi/tree/main)

### Available Endpoints

- Hermes: <https://hermes.ai.unturf.com/v1> - General purpose conversational AI
- Qwen 3 Coder: <https://qwen.ai.unturf.com/v1> - Specialized coding model
- TTS: <https://speech.ai.unturf.com/v1> - Text-to-speech generation

## Plan a better backend one that doesn't use java

I am tired of the boilerplate and bug factory that is java, it serves no real purpose and has no real benefit other than being looking good in indian resumes, I hoesnly don't want to look at java anymore.

For the love of god, do something use go or python idk if the [plan](./migration.md) is still upto date or good, so maybe remake it when tackling this issue.

## Do we really need a separate worker?

like what does the backend do that cannot be done by the worker, why do we need this split?

## validate if the testing is really testing or just mocking everything and calling it a day

Check the [test-guide](./testing_isolation_guide.md) and make sure the tests are actually testing the code and not just mocking everything and calling it a day.

## Update the `configuration_guide.md` once everything is done

We need to document how to setup the whole app like what needs to be populated in `.env` and what needs to populated in the secrets, how to set up the `providers.json` and other small stuff.
