import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { Resvg } from "@resvg/resvg-js";

export interface MathSegment {
  kind: "text" | "math";
  content: string;
  display: boolean;
}

const EX_PX = 8;
const MAX_TEX_LENGTH = 2_000;

// Display math: $$...$$ or \[...\]. Inline math: \(...\) or $...$.
// Escaped dollar signs (\$) never start a match.
const mathPattern =
  /(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]|(?<!\\)\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g;

export function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (/[\\^_{}=+*/]/.test(trimmed)) return true;
  // Single short identifiers such as $x$ or $q1$ count as math.
  return /^[a-zA-Z][a-zA-Z0-9]?$/.test(trimmed);
}

function pushText(segments: MathSegment[], text: string): void {
  if (!text) return;
  const last = segments.at(-1);
  if (last?.kind === "text") last.content += text;
  else segments.push({ kind: "text", content: text, display: false });
}

function tokenizeMath(text: string, segments: MathSegment[]): void {
  let index = 0;
  for (const match of text.matchAll(mathPattern)) {
    const start = match.index;
    if (start === undefined) continue;
    const content = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
    const display = match[1] !== undefined || match[2] !== undefined;
    if (!content || content.length > MAX_TEX_LENGTH) continue;
    if (!display && !looksLikeInlineMath(content)) continue;
    pushText(segments, text.slice(index, start));
    segments.push({ kind: "math", content, display });
    index = start + match[0].length;
  }
  pushText(segments, text.slice(index));
}

// Splits a reply into plain-text and math segments. Fenced blocks and inline
// code stay verbatim so code samples are not rewritten into formulas.
export function splitMathSegments(text: string): MathSegment[] {
  const segments: MathSegment[] = [];
  const codePattern = /```[\s\S]*?```|`[^`\n]*`/g;
  let index = 0;
  for (const match of text.matchAll(codePattern)) {
    const start = match.index;
    if (start === undefined) continue;
    tokenizeMath(text.slice(index, start), segments);
    pushText(segments, match[0]);
    index = start + match[0].length;
  }
  tokenizeMath(text.slice(index), segments);
  return segments;
}

interface Renderer {
  convert(tex: string, display: boolean): string;
}

let rendererPromise: Promise<Renderer> | null = null;

function getRenderer(): Promise<Renderer> {
  if (!rendererPromise) {
    rendererPromise = (async () => {
      const adaptor = liteAdaptor();
      RegisterHTMLHandler(adaptor);
      const tex = new TeX({ packages: AllPackages });
      const svg = new SVG({ fontCache: "local" });
      const document = mathjax.document("", { InputJax: tex, OutputJax: svg });
      return {
        convert(input: string, display: boolean): string {
          const node = document.convert(input, {
            display,
            em: 16,
            ex: EX_PX,
            containerWidth: 100_000,
          });
          return adaptor.outerHTML(node as never);
        },
      };
    })();
  }
  return rendererPromise;
}

export async function renderTexToPng(tex: string, display: boolean): Promise<Buffer> {
  const renderer = await getRenderer();
  const container = renderer.convert(tex, display);
  const svgMatch = container.match(/<svg[\s\S]*<\/svg>/);
  if (!svgMatch) throw new Error("MathJax did not return SVG output.");
  let svg = svgMatch[0];
  const widthEx = Number(svg.match(/width="([\d.]+)ex"/)?.[1]);
  const heightEx = Number(svg.match(/height="([\d.]+)ex"/)?.[1]);
  if (!Number.isFinite(widthEx) || !Number.isFinite(heightEx)) {
    throw new Error("MathJax returned an SVG without ex dimensions.");
  }
  const width = widthEx * EX_PX;
  const height = heightEx * EX_PX;
  svg = svg
    .replace(/width="[\d.]+ex"/, `width="${width}"`)
    .replace(/height="[\d.]+ex"/, `height="${height}"`);
  const pad = 14;
  const totalWidth = width + pad * 2;
  const totalHeight = height + pad * 2;
  const wrapped =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    svg.replace(/^<svg /, `<svg x="${pad}" y="${pad}" `) +
    `</svg>`;
  const zoom = Math.min(3, Math.max(1, 1600 / totalWidth));
  const resvg = new Resvg(wrapped, {
    fitTo: { mode: "zoom", value: zoom },
    background: "#ffffff",
  });
  return Buffer.from(resvg.render().asPng());
}
