# Issues

## The UI doesn't show only the providers we have API keys for

This was designed but didn't work - we need to revisit this

### The System Settings was empty on first load had to manually set everything (this creates the user global over ride scenario)

Meaning the default population is not working, needed to over ride it. This shouldn't have happneded, I should have seen these

```json
"defaults": {
    "provider": "openrouter",
    "tl": "deepseek/deepseek-v4-pro",
    "qaLLM": "deepseek/deepseek-v4-flash",
    "qaVLM": "google/gemini-3.1-flash-lite",
    "ocr": "qwen/qwen3-vl-32b-instruct"
  }
```

### The free models have (free)(free) on them twice

Minor visual bug

### Also the mapping is not working in chapter and series pages but it works for the global System settings

```json
"tl": [
          { "id": "nvidia/riva-translate-4b-instruct-v1.1", "name": "Riva Translate 4B" },
          { "id": "nvidia/llama-3.1-nemotron-70b-instruct", "name": "Llama 3.1 Nemotron 70B Instruct" },
          { "id": "meta/llama-3.1-405b-instruct", "name": "Llama 3.1 405B Instruct" }
        ]
```

In the global settings view the model for provider filter works but it isn't working in series, chapter, create and edit views

### The strategy selector and chapter, series cards need improvement

As shown in the picture

## Need to enrich the [providers.json](../config/providers.json) for more models

Remove the useless models and add good ones, add nueromatic and cloud flare AI workers

## Non JP OCR sucks

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/05bdb802-4e85-481a-8fd7-0e68c7aec157/test-korean/reader/1`

It's so bad it's almost as it the OCR model isn't even trying

## Some how a chapter with only one image got added as page 21

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/6449e3bf-77c8-476a-9055-416be0214737/blue-archive/reader/1`

Check the logs and find out how

Also the message shows redircting but does not.

## Interesting new bug

```txt
S3 operation failed; code: NoSuchKey, message: The specified key does not exist., resource: /manga-library/rendered/fa662cc2-b853-4a1a-a35c-63707422f3
```

Seen on

Quality Assurance · Page 1

openrouter / deepseek/deepseek-v4-pro
FAILED
Attempt 3/310:15 pm
S3 operation failed; code: NoSuchKey, message: The specified key does not exist., resource: /manga-l...

## Only for the use fall back models the X doesn't show up when over ridden

Same as title

## There are multiple sources of truth and that's an issue

What takes presciende, the global settings, the users over rides or the config/providers.json](../config/providers.json)?

Ideally the defaults should be synced, so I propose if the user over rides the global settings we should store it in the database, the globals in the providers.json change then the users data should be checked and if the provider and required models are still available then we can keep it as it is but if they are removed need to mark them as deprecated and show a notification.

## Analyze todays logs for error and issues

Same as title, check the logs folder and check stuff from today

## The backend doesn't have any heartbeat logs it's almost silent

Same as title

## Moving Pages One by one works in the chapter view, but in the reader view changing page number in page view doesn't work

It gives `Failed to update page number` toats check the logs

## The dark clour scheme sucks, the red is too jarring on the amoled dark (see yt-diff scresnhots for inspirtion)

Need to use material UI paper on some surfaces to make it look better, some buttons need be filled (outlined buttons look even more ugly),

The queue manager keeps changing it's size the table needs to have static ratios based on view ports and not let the content change it as it sees fit.

## When changing chapters, we can briefly see the previous chapter's content

It's as if they are still rendered in the DOM only getting pushed out when new chapter loads, even if that's the case it shouldn't be slow enough for human eyes to notice

## Strictly free tl doesn't seem to be free

`https://ideapad.tail9ece4.ts.net/tlhub/chapters/92e09c9f-1376-4f3f-b1f9-81296f7c7c67/test` is configured to use neuromatic which is free and the QA is disabled so why does the log show spend and deep seek being called?

## I sense bugs in

- Post manual edits, re-render
- Context injection
- Cache re-use for translation and QA, I want to make sure if we are using the same model for TL and QA we can re-use the same cache key (should also print the cache key in logs)
- Provider and model inheritance and ovderides
- Uploader, because something has to be responsible for line 51 issue
- Fallback handling

## Also important work that needs to be prioritized

- [ ] Add support for cloudflare workers AI, it has genrous free limits so why not use if for bulk testing
- [ ] Need to use playwright for E2E testing
  - [ ] I want to upload a test image and have it translated, match expected outputs
- [ ] Improve the TL, there are still some images that are translated horribly when compared to the competitirs.
  - [ ] Curate more examples and have a VLM like Kimi K3 analyze and find out what the others do and how we can do it as well
  - [ ] Improve the TL process
  - [ ] Make the renders as good as the frontend renders. The frontend ones are much better than the renders which are dogshit.
