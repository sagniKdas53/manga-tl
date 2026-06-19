# Translation seems to be improvng but bubble groupong isn't

Looking at your examples, the translation quality is improving because you're feeding better OCR into a better LLM. The typesetting quality is getting worse because your pipeline is optimizing for **text accuracy**, not **layout reconstruction**.

The PP-OCRv5 visualization is actually showing the root cause:

* OCR detects many small text chunks independently.
* Your translator translates those chunks independently.
* Your typesetter places translated text back into the original OCR boxes.
* English is wider than Japanese.
* Vertical Japanese bubbles become fragmented English bubbles.

That's why v3 has better wording but terrible composition.

## What's going wrong

### Current pipeline

```text
Image
  ↓
OCR
  ↓
Text Boxes
  ↓
Translate Each Box
  ↓
Render Into Same Box
```

For this page OCR finds something like:

```text
[お兄ちゃん…]
[本当にやるの？]

[ああ、着替えたら]
[向こうの]
[岩場に集合な]

[こんなチャンス]
[めったに無い…]
[楽しみだろ？]
```

The translator then gets tiny fragments.

Result:

```text
"Ah"
"After changing"
"Gather at"
"The rocky area"
```

which creates the disaster shown in Auto Typeset v1/v2.

---

## What manga translators actually do

They work at the **speech bubble level**, not OCR box level.

Instead:

```text
OCR Boxes
    ↓
Bubble Detection
    ↓
Group OCR Boxes Inside Bubble
    ↓
Translate Entire Bubble
    ↓
Typeset Entire Bubble
```

For example:

```text
ああ、着替えたら
向こうの
岩場に集合な
```

becomes

```text
Yeah.
Once you've changed,
meet me by those rocks.
```

One translation.

One bubble.

One layout.

---

# Fix #1 (Highest Priority)

Add a bubble grouping stage.

```text
OCR
 ↓
Detect Speech Bubbles
 ↓
Assign Text Regions To Bubble
 ↓
Merge Text
 ↓
Translate
 ↓
Typeset
```

For manga this is probably the single biggest quality jump.

You can use:

* OpenCV contour detection
* SAM2
* Grounding DINO + SAM
* Florence 2
* Qwen2.5-VL

to detect bubble boundaries.

---

# Fix #2

Store reading order before translation.

Japanese OCR often returns:

```text
A
B
C
```

in arbitrary order.

You need:

```python
sort by:
    right-to-left
    top-to-bottom
```

for vertical Japanese.

Otherwise:

```text
こんなチャンス
めったに無い
楽しみだろ
```

becomes

```text
Such a chance...
You're excited...
Rare...
```

which I can see happening in some of the generated pages.

---

# Fix #3

Translate page context, not bubble context.

Current:

```text
Bubble 1 -> translate
Bubble 2 -> translate
Bubble 3 -> translate
```

Better:

```text
Page OCR
 ↓
LLM
 ↓
JSON output for all bubbles
```

Example:

```json
{
  "bubble_1": "Big brother... are you really going to do it?",
  "bubble_2": "Yeah. Once you've changed, meet me by those rocks.",
  "bubble_3": "A chance like this doesn't come often. You're excited, aren't you?",
  "bubble_4": "I'll just tell Mom and the others something."
}
```

The model understands the conversation flow.

---

# Fix #4

Stop preserving original OCR boxes.

This is the mistake most manga translators make initially.

Current:

```text
Japanese box width = 60px
English text width = 180px

=> squished text
```

Instead:

```text
Bubble detected
 ↓
Find usable interior area
 ↓
Fit translated text to bubble
```

Ignore the OCR rectangles completely during rendering.

OCR rectangles are only for extracting text.

---

# Fix #5

Use a typesetting algorithm

For each bubble:

```python
1. Find bubble polygon
2. Compute largest inscribed rectangle
3. Word wrap translation
4. Binary search font size
5. Center text vertically
6. Center text horizontally
```

This alone would make your v3 look dramatically better.

---

# Fix #6

Add a "translation length controller"

Japanese:

```text
こんなチャンスめったに無い
```

Literal:

```text
A chance like this rarely comes along.
```

Manga typeset version:

```text
A chance like this
doesn't come often.
```

Shorter text = better fit.

Prompt your LLM:

```text
Translate for manga typesetting.

Requirements:
- Natural English
- Preserve meaning
- Minimize word count
- Fit inside speech bubbles
```

---

# Fix #7 (Most Important Long-Term)

Move from OCR → Translation to Vision → Translation.

Instead of:

```text
OCR
 ↓
LLM
```

Use:

```text
Qwen2.5-VL
 ↓
Describe page
 ↓
Extract dialogue
 ↓
Translate
```

The model sees:

* bubble boundaries
* speaker relationships
* reading order
* context

which dramatically improves both translation and layout.

---

If I were designing your manga translator from scratch, the next version would be:

```text
Image
 ↓
PP-OCRv5
 ↓
Bubble Detection (SAM2/OpenCV)
 ↓
Reading Order Resolver
 ↓
Bubble Grouping
 ↓
Translate Entire Page (DeepSeek V4 Pro)
 ↓
Manga-Aware Typesetter
 ↓
Inpainting + Render
```

That would give a much larger quality jump than switching translation models again, because your current bottleneck is no longer translation quality—it's document layout reconstruction.
