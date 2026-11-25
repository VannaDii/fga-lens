import { expect, type Locator } from "@playwright/test";

/** Measure a rendered color against the visible surface behind the element. */
export async function expectContrast(element: Locator, minimum = 4.5, property = "color", surface?: Locator) {
  const foreground = await element.evaluate((node, name) => getComputedStyle(node).getPropertyValue(name), property);
  const ratio = await (surface ?? element).evaluate((node, color) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const pixel = canvas.getContext("2d", { willReadFrequently: true })!;
    const backgrounds = [];
    for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
      backgrounds.unshift(getComputedStyle(ancestor).backgroundColor);
    }
    const fill = (value: string) => {
      pixel.fillStyle = value;
      pixel.fillRect(0, 0, 1, 1);
    };
    const luminance = () => {
      const [red, green, blue] = Array.from(pixel.getImageData(0, 0, 1, 1).data, (channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return .2126 * red + .7152 * green + .0722 * blue;
    };
    backgrounds.forEach(fill);
    const background = luminance();
    fill(color);
    const text = luminance();
    return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
  }, foreground);
  expect(ratio, `${property} contrast on ${element}`).toBeGreaterThanOrEqual(minimum);
}
