# Linting

After that, your workflow stays the same as before:

```bash
mvn spotless:apply     # auto-format before committing
mvn clean verify       # full quality gate (tests + coverage + PMD + SpotBugs)
mvn spotless:check     # optional: verify formatting is clean
```
