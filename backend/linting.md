# Linting

Fixed. The `<executions>` block is removed from Spotless — it no longer hooks into the `validate` phase, so your IDE builds stop failing.

**Why this is correct for an existing codebase:** binding `spotless:check` to a lifecycle phase is only appropriate when you introduce Spotless on a *greenfield* project where all files are already formatted. On an existing project with 50 files that have their own style, you need to run the one-time fix first, then optionally re-add the binding.

**To clean up the existing violations now, run once:**

```bash
mvn spotless:apply
```

After that, your workflow stays the same as before:

```bash
mvn spotless:apply     # auto-format before committing
mvn clean verify       # full quality gate (tests + coverage + PMD + SpotBugs)
mvn spotless:check     # optional: verify formatting is clean
```

If you want to enforce formatting in CI later (after `spotless:apply` has been run and committed), you can wire it back in at that point.
