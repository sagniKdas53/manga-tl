# Issues and What I want for them

## CI failing (done)

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

## Same image handling had not worked for a long time now (done)

Idea [duplicate_handling](./duplicate_handling.md)

## The queue manangemt has become absolute shit

It takes 2 hours to process 50 images, just check the logs.

Log in question [run-3-fresh.log](../logs/run-3-fresh.log) for details.

Atlest the OCR which has a deidated slot as described in [slot_allocation](./slot_allocation.md) should have been prioritized and completed.

Also check if the queue docs are upto date [queue_management_system](./translation_pipeline_phases.md) and if there are any optimizations not yet uncovered.

Check out the provider intgeration guide as well [workers_providers](./worker_provider_integration.md) same idea check if outdated and update also check for optimizations, I believe this was created before the `providers.json` was added so more likely outdated.

## `index.js` is still too big

```log
#33 1.753 vite v8.1.5 building client environment for production...
transforming...✓ 1007 modules transformed.
#33 2.544 rendering chunks...
#33 2.786 computing gzip size...
#33 2.797 dist/index.html                                1.40 kB │ gzip:   0.58 kB
#33 2.797 dist/assets/index-25aYWvJ6.css                19.82 kB │ gzip:   4.19 kB
#33 2.797 dist/assets/Add-D2elZn0Y.js                    0.15 kB │ gzip:   0.15 kB
#33 2.797 dist/assets/ChevronRight-BbxKGv4f.js           0.17 kB │ gzip:   0.17 kB
#33 2.797 dist/assets/Delete-q3BXIOR3.js                 0.19 kB │ gzip:   0.18 kB
#33 2.797 dist/assets/CardContent-COFQLqYd.js            0.99 kB │ gzip:   0.49 kB
#33 2.797 dist/assets/CardMedia-CDWC0WiR.js              1.90 kB │ gzip:   0.85 kB
#33 2.797 dist/assets/Divider-D9Ns4fN2.js                3.45 kB │ gzip:   1.22 kB
#33 2.797 dist/assets/MenuItem-DKQP0Xf7.js               3.73 kB │ gzip:   1.57 kB
#33 2.797 dist/assets/Upload-C0VoJ9V1.js                 4.03 kB │ gzip:   1.67 kB
#33 2.797 dist/assets/TextField-BxS6ZWMI.js              4.16 kB │ gzip:   1.77 kB
#33 2.797 dist/assets/Grid-BEwsF91D.js                   4.73 kB │ gzip:   1.93 kB
#33 2.797 dist/assets/Auth-DB-yZvzM.js                   5.24 kB │ gzip:   2.25 kB
#33 2.797 dist/assets/UserManagementModal-CxinLifm.js    7.18 kB │ gzip:   2.91 kB
#33 2.797 dist/assets/FormControlLabel-56vLE-I7.js       7.57 kB │ gzip:   2.92 kB
#33 2.797 dist/assets/SettingsModal-DBfmqmJx.js          8.60 kB │ gzip:   2.51 kB
#33 2.797 dist/assets/Dashboard-GcV4I_73.js              9.10 kB │ gzip:   3.45 kB
#33 2.797 dist/assets/Edit-BDoM0XnO.js                  13.40 kB │ gzip:   3.95 kB
#33 2.797 dist/assets/ChapterGallery-DWF3ROVN.js        19.17 kB │ gzip:   6.23 kB
#33 2.797 dist/assets/SeriesDetails-Dzbh-P6w.js         19.76 kB │ gzip:   5.95 kB
#33 2.797 dist/assets/Select-DIbBijrF.js                56.21 kB │ gzip:  17.61 kB
#33 2.797 dist/assets/useSlotProps-EjgVaUNX.js         159.72 kB │ gzip:  54.07 kB
#33 2.797 dist/assets/Reader-c57_Ipdj.js               220.20 kB │ gzip:  65.52 kB
#33 2.797 dist/assets/index-qL-64He4.js                375.16 kB │ gzip: 120.29 kB
#33 2.797 
#33 2.798 ✓ built in 1.04s
#33 2.826 npm notice
#33 2.826 npm notice New major version of npm available! 11.17.0 -> 12.0.2
#33 2.826 npm notice Changelog: https://github.com/npm/cli/releases/tag/v12.0.2
#33 2.826 npm notice To update run: npm install -g npm@12.0.2
#33 2.826 npm notice
#33 DONE 3.2s
```

These files can't possibly be that complex, something funky is going on.

## The UI is laggy and loads slow

General observation, will do a proper firefox profile analysis later.

Most probably the backend holding it back, but it's probably just the inhertiatnace and overrides + the logic bugs.

## Add an export rendered PNG button (done)

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
