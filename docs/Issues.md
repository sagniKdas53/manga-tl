# Issues

## Creating a series with over-rides doesn't seem to preserve the over-rides

While creating a chapter does, also the chapter card is still wrong but atlest it preserved the data inside it

See screenshots in [folder](../examples/Inheritance%20and%20creation%20issues/)

## There is a free space in the over-rides modal, add a use fallback models option

Two choices trur or false group these under advanced configurations

## Show us the provider selected because of our routing choices

It should be shown in the logs also present in the json for the project export (on that note re-validate the project and chapter export jsons)

Look in [folders](../examples/Chpater%20and%20Project%20Export/)

## The colour selector in the front-end should have more clours

Also it's transparency option doesn't work it defaults to white when clicked on the transparent option

## The chapter card has too many buttons

Export chapter as zip should internally smartly do the job of the Re-export button and Clear exports is not needed as we have a scheduler but since we have it, we can hide it inside the edit chapter modal (or maybe not)

## Errors in logs

```log
manga-backend    | 2026-07-20T18:33:10.499Z ERROR 1 --- [manga-library-backend] [nio-8080-exec-5] c.m.library.controller.SeriesController  : Failed to download export
manga-backend    | 
manga-backend    | io.minio.errors.ErrorResponseException: The specified key does not exist.
manga-backend    |      at io.minio.BaseS3Client$1.onResponse(BaseS3Client.java:507) ~[minio-9.0.3.jar!/:9.0.3]
manga-backend    |      at io.minio.BaseS3Client$1.onResponse(BaseS3Client.java:367) ~[minio-9.0.3.jar!/:9.0.3]
manga-backend    |      at okhttp3.internal.connection.RealCall$AsyncCall.run(RealCall.kt:519) ~[okhttp-4.12.0.jar!/:na]
manga-backend    |      at java.base/java.util.concurrent.ThreadPoolExecutor.runWorker(Unknown Source) ~[na:na]
manga-backend    |      at java.base/java.util.concurrent.ThreadPoolExecutor$Worker.run(Unknown Source) ~[na:na]
manga-backend    |      at java.base/java.lang.Thread.run(Unknown Source) ~[na:na]
manga-backend    | 
```

Also many other look in the [logs](../logs/run-1.log)

## Bubbles keep over lapping each other

This is an issue to tackle later but this needs our attention as part of the wider TODO's
