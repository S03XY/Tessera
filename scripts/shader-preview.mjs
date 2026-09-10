#!/usr/bin/env node
/**
 * Renders the hero fragment shader to a PNG, off the app entirely.
 *
 *   node scripts/shader-preview.mjs [--out name] [--w 1440] [--h 900]
 *                                   [--px 0.4] [--py 0.2] [--t 3.0] [--grid]
 *
 * Iterating on a shader through the dev server means a page load, a hydration
 * and a scroll position for every one-line change to a constant. This renders
 * the same GLSL in isolation at a fixed time and pointer position, so a change
 * can be looked at in about a second.
 *
 * `--grid` renders a contact sheet across several pointer positions at once,
 * which is the only honest way to check that an interactive surface looks good
 * everywhere rather than just at the one spot you happened to test.
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "/tmp/shots";
mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const OUT = flag("out", "shader");
const CSS_W = Number(flag("w", 1440));
const CSS_H = Number(flag("h", 860));
const DPR = Number(flag("dpr", 1.75));
// The buffer is what the shader actually sees; u_px ties field units to CSS px.
const W = Math.round(CSS_W * DPR);
const H = Math.round(CSS_H * DPR);
const T = Number(flag("t", 3.0));

/* Roughly where the h1 sits in the real hero, in buffer px, y-up. */
const LAND = has("land")
  ? [W * 0.06, H * 0.30, W * 0.72, H * 0.66]
  : [0, 0, 0, 0];

/**
 * The shader lives in a .ts module as an exported template literal, so the app
 * and this tool cannot drift apart. Pulling it out with a regex rather than
 * importing keeps this script free of a TypeScript loader.
 */
function loadShader() {
  const source = readFileSync(join(root, "src/components/hero-shader.ts"), "utf8");
  const match = source.match(/export const HERO_FRAGMENT_SHADER = `([\s\S]*?)`;/);
  if (!match) {
    console.error("Could not find HERO_FRAGMENT_SHADER in src/components/hero-shader.ts");
    process.exit(1);
  }
  return match[1];
}

let FRAGMENT = loadShader();

/*
 * --show <expr> replaces the final write with a normalised view of one
 * intermediate. Looking at the terms is the only way to tell "the band is
 * subtle" apart from "the band is mathematically zero".
 */
const SHOW = flag("show", null);
if (SHOW) {
  FRAGMENT = FRAGMENT.replace(
    /fragColor = vec4\(max\(col, vec3\(0\.0\)\), 1\.0\);/,
    `{ float dbg = float(${SHOW}); fragColor = vec4(vec3(dbg), 1.0); }`,
  );
}

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Pointer positions for the contact sheet: corners, edges, centre, resting. */
const GRID = [
  { label: "top-left", px: -0.85, py: 0.7 },
  { label: "top-right", px: 0.85, py: 0.7 },
  { label: "centre", px: 0.0, py: 0.0 },
  { label: "bottom-left", px: -0.85, py: -0.7 },
  { label: "bottom-right", px: 0.85, py: -0.7 },
  { label: "resting", px: 0.12, py: -0.05 },
];

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#08080a;}
  canvas{display:block;}
</style></head>
<body><canvas id="c"></canvas>
<script>
window.__render = function (w, h, px, py, energy, t, coarse, land, upx) {
  const c = document.getElementById("c");
  c.width = w; c.height = h;
  c.style.width = (w/upx) + "px"; c.style.height = (h/upx) + "px";
  const gl = c.getContext("webgl2", { alpha: false, antialias: false, depth: false });
  if (!gl) return "no-webgl2";
  function sh(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return gl.getShaderInfoLog(s);
    return s;
  }
  const vs = sh(gl.VERTEX_SHADER, ${JSON.stringify(VERTEX)});
  if (typeof vs === "string") return "VERTEX: " + vs;
  const fs = sh(gl.FRAGMENT_SHADER, ${JSON.stringify(FRAGMENT)});
  if (typeof fs === "string") return "FRAGMENT: " + fs;
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return "LINK: " + gl.getProgramInfoLog(p);
  gl.useProgram(p);
  gl.bindVertexArray(gl.createVertexArray());
  gl.viewport(0, 0, w, h);
  gl.uniform2f(gl.getUniformLocation(p, "u_res"), w, h);
  gl.uniform1f(gl.getUniformLocation(p, "u_time"), t);
  gl.uniform2f(gl.getUniformLocation(p, "u_pointer"), px, py);
  gl.uniform1f(gl.getUniformLocation(p, "u_energy"), energy);
  gl.uniform1f(gl.getUniformLocation(p, "u_reveal"), 1.0);
  gl.uniform1f(gl.getUniformLocation(p, "u_px"), upx);
  gl.uniform1f(gl.getUniformLocation(p, "u_quality"), 1.0);
  gl.uniform1f(gl.getUniformLocation(p, "u_coarse"), coarse);
  gl.uniform4f(gl.getUniformLocation(p, "u_land"), land[0], land[1], land[2], land[3]);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return "ok";
};
</script></body></html>`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Math.ceil(CSS_W), height: Math.ceil(CSS_H) } });
const tab = await ctx.newPage();
await tab.setContent(page);

async function shot(name, px, py, energy, t) {
  const status = await tab.evaluate(
    ([w, h, x, y, e, time, coarse, land, upx]) => window.__render(w, h, x, y, e, time, coarse, land, upx),
    [W, H, px, py, energy, t, has("coarse") ? 1 : 0, LAND, DPR],
  );
  if (status !== "ok") {
    console.error(`\n${status}\n`);
    await browser.close();
    process.exit(1);
  }
  const el = await tab.$("#c");
  await el.screenshot({ path: `${OUT_DIR}/${name}.png` });
  console.log(`  ${name}.png   pointer(${px}, ${py}) energy=${energy} t=${t}`);
}

if (has("grid")) {
  console.log(`contact sheet ${CSS_W}x${CSS_H} css @${DPR}x:`);
  for (const g of GRID) await shot(`${OUT}-${g.label}`, g.px, g.py, 0.35, T);
} else {
  console.log(`render ${CSS_W}x${CSS_H} css @${DPR}x = ${W}x${H} buffer:`);
  await shot(OUT, Number(flag("px", 0.4)), Number(flag("py", 0.2)), Number(flag("energy", 0.4)), T);
}

await browser.close();
