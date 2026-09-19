import {
  renderPageSceneSvg,
  resolvePageScene,
  resolvedTextLayout,
  type PageSceneContentInput,
} from "../../../packages/page-scene/src/index.js";

export function mountPageScene(input: PageSceneContentInput) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("browser canvas text measurement is unavailable");
  const scene = resolvePageScene(input, (font, text) => {
    context.font = font;
    return context.measureText(text).width;
  });
  document.body.innerHTML = renderPageSceneSvg(scene);
  return {
    diagnostics: scene.diagnostics,
    layout: resolvedTextLayout(scene),
    width: input.source.width,
    height: input.source.height,
  };
}
