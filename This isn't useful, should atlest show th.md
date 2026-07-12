This isn't ![notification](./examples/chapter-export/notification.png) useful, should atlest show the series > chapter name that is exported.

Also all the zips are named as `chapter_export` we can do better than that

Also I think I figured it out

I exported <https://ideapad.tail9ece4.ts.net/tlhub/chapters/f553bd58-ebf5-4ca1-8fa0-c75b8027f0a4/addicent>

see [no-rendered](/home/sagnik/Projects/docker-composes/manga-library/examples/chapter-export/transalted-before-app-restart/)

none of the images in the zip were rendered, as it was translated before the stack was restarted,
and I believe the rendered images are just getting saved to disk and lost after restart not to minio

also just translated chapters have their rendered images

see [rendered](/home/sagnik/Projects/docker-composes/manga-library/examples/chapter-export/after/) even partially processed chapters have those

Also we don't need two toasts for the same message ![two taosts](./examples/chapter-export/don't_need_2_toasts.png)

Lastly make sure that we have expiary and auth on the chapter zip download and if the same chapter is exported without any changes we don't re-render jsy extend the expiary of the previous url (if we have it in cache)

Document the changes we made while implementing the plan as a note for pahse 2, add these as well and their fixes as well
