# VLM OCR Benchmark Report (Sample 1)

This report summarizes the performance of various Vision Language Models (VLMs) when used for OCR extraction on Manga speech bubbles.

## Methodology
- **Input:** 3 speech bubbles detected via YOLO segmentation from `original.jpeg`.
- **Task:** Extract all visible characters exactly as written, returning them as a JSON object (via constrained prompt).
- **Language:** Japanese

## Results Summary

| Model | Speed (per bubble) | Cost (per 3 bubbles) | Accuracy / Quality |
|---|---|---|---|
| **`qwen/qwen3-vl-30b-a3b-instruct`** | **1.19s** | $0.000259 | **Excellent** - Spot on extraction, fastest model. |
| **`qwen/qwen3-vl-8b-instruct`** | 1.66s | **$0.000095** | **Excellent** - Very accurate, cheapest non-free option. |
| **`qwen/qwen-2.5-vl-72b-instruct`** | 1.95s | $0.000853 | Excellent - Reliable, high quality. |
| **`google/gemini-3.1-flash-lite`** | 2.32s | $0.000274 | Excellent - Highly accurate and very fast. |
| **`qwen/qwen3-vl-32b-instruct`** | 2.39s | $0.000379 | Excellent - High quality, slightly slower. |
| **`nvidia/nemotron-nano-12b-v2-vl`** | 4.23s | **$0.000000** | **Poor** - Noticeably struggled with missing characters and slight hallucinations. |
| **`google/gemini-3.5-flash`** | 5.38s | $0.000382 | Excellent - High quality but surprisingly slow. |

## Conclusion
The newer **Qwen3-VL** models excel at this task. 
- The **30B A3B** model stands out as the absolute fastest option while maintaining perfect accuracy. 
- The **8B** model is the most cost-effective option for bulk processing without sacrificing OCR quality. 
- The **Gemini** models (3.1 Flash Lite and 3.5 Flash) provide excellent, flawless extraction of Japanese text. The 3.1 Flash Lite model is incredibly fast and cost-effective, positioning it as a fantastic alternative to Qwen3.
- The free Nvidia model struggles with the nuance and tiny fonts typical in Japanese manga and is not recommended for production OCR.
