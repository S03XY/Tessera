/**
 * "Face Mill" — the hero plate.
 *
 * One face-milled graphite plate, bled off all four edges. It is partitioned
 * into an offset-course lattice of tesserae, and each tessera is brushed at one
 * of eight indexed angles, 22.5° apart, like a part re-clamped on a rotary
 * table between passes.
 *
 * The sun is a compile-time constant and never moves — that is the design
 * system's own rule ("one highlight value for every lit edge in the app, so the
 * sun never moves"). The pointer tilts the *part*, not the light. Because the
 * plate carries a slight cylindrical crown, a few degrees of tilt drags the
 * specular band across most of the frame, and because every tile answers that
 * light at its own angle, tiles snap in and out of the streak individually with
 * hard square boundaries. The mosaic assembles and dissolves as you move; at
 * rest it is almost nothing.
 *
 * That is the semantic claim, and both halves have to be true: the plate IS
 * many independently indexed pieces, and the continuous grain phase and the
 * gouge lanes crossing seams prove they are one part.
 *
 * Two properties are load-bearing rather than stylistic:
 *
 *   1. **Nothing is a function of time.** The picture is a pure function of
 *      position and pointer. That is what makes crawl and shimmer structurally
 *      impossible, and it is what makes the reduced-motion still frame a real
 *      frame rather than a degradation.
 *   2. **Nothing exceeds `--metal-hi`.** The final operation is a hard clamp to
 *      #2e2e31, a value that already exists on rails elsewhere in the app, so
 *      the brightest pixel that can ever sit behind a glyph is a known constant
 *      and every contrast ratio in the section is provable rather than hoped
 *      for. Over the h1's own rect the ceiling drops further still.
 */
export const HERO_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform vec2  u_res;      // drawing-buffer size, device px
uniform vec2  u_pointer;  // damped, y-up, ~[-1.6, 1.6]
uniform float u_reveal;   // 0 -> 1 on mount
uniform vec4  u_land;     // h1 rect in buffer px, y-up (x0,y0,x1,y1)
uniform float u_px;       // device px per CSS px, folds in DPR and adaptive scale
uniform float u_quality;  // 1 full, 0 reduced
uniform float u_coarse;   // 1 on a coarse pointer

out vec4 fragColor;

const float PI = 3.141592653589793;

/* The palette, straight from the token file. Nothing here is invented. */
const vec3 BG_SUBTLE = vec3(0.03137, 0.03137, 0.03922); // #08080a
const vec3 METAL_LO  = vec3(0.09020, 0.09020, 0.10196); // #17171a
const vec3 METAL_HI  = vec3(0.18039, 0.18039, 0.19216); // #2e2e31
const vec3 BG_INSET  = vec3(0.09804, 0.09804, 0.09804); // #191919

/* The sun. A constant, forever. */
const vec3  L0 = vec3(0.0, 0.41927, 0.90786);
/* Cylindrical crown: the reason a small tilt moves the highlight a long way. */
const float Kc = 0.30;
const vec2  CROWN_AXIS = vec2(0.62177, 0.78320);
/*
 * The plate's resting attitude on the bench.
 *
 * Without it the crown can only put the reflected band where the geometry
 * happens to place it, which is off the bottom-left corner — the band is real,
 * the arithmetic is right, and nothing is visible on screen. A few degrees of
 * set brings it onto the plate at rest, in the upper right, clear of the h1's
 * optical centre. It is applied to the macro and micro normals alike, so the
 * sheen and the per-tile hairline always agree about where the light is.
 */
const vec2  SET_TILT = vec2(-0.1722, -0.2169);

/* --------------------------------------------------------------- hashing */

/*
 * Integer hash. Deliberately not fract(sin(dot(...))) — that bands visibly on
 * this palette's ~38 available levels and diverges between GPU vendors, so the
 * lattice would differ between a desktop and a phone.
 */
uint hashu(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v.x;
}

float hf(ivec2 v) {
  return float(hashu(uvec2(v + 4096))) * (1.0 / 4294967296.0);
}

/* 1-D value noise with its analytic derivative — no texture, no gradients. */
vec2 vnoise(float x, int seed) {
  float i = floor(x);
  float f = x - i;
  int ii = int(i);
  float a = hf(ivec2(ii, seed));
  float b = hf(ivec2(ii + 1, seed));
  float w = f * f * (3.0 - 2.0 * f);
  float dw = 6.0 * f * (1.0 - f);
  return vec2(mix(a, b, w), (b - a) * dw);
}

/* Small-angle rotation of a direction about the two in-plane axes. */
vec3 tiltDir(vec3 d, vec2 t) {
  // Exact enough below ~10° and two instructions cheaper than building a basis.
  return normalize(vec3(d.x + t.x * d.z, d.y + t.y * d.z, d.z - t.x * d.x - t.y * d.y));
}

void main() {
  vec2 frag = gl_FragCoord.xy;

  /* ------------------------------------------------------- coordinates */

  // Aspect-correct screen space, y in +-0.5.
  vec2 s = (frag - 0.5 * u_res) / u_res.y;

  float cssMin = min(u_res.x, u_res.y) / max(u_px, 0.0001);
  // Course height in CSS px: fixed on desktop, vmin-derived on a phone so the
  // tiles do not become absurdly large relative to the viewport.
  float S = mix(132.0, clamp(0.20 * cssMin, 74.0, 132.0), u_coarse);

  // Field space. One unit is one course. NOTHING here depends on time.
  vec2 p = (frag - 0.5 * u_res) / (u_px * S);

  // Pixel footprint in field units, from the continuous field position — never
  // from fwidth() of a tile-local value, which spikes at every seam and paints
  // a halo along the whole lattice.
  float fw = max(fwidth(p.x), fwidth(p.y));

  /* ------------------------------------- lattice: offset courses of tiles */

  float row   = floor(p.y);
  int   irow  = int(row);
  float phase = hf(ivec2(irow, 7));                    // per-course offset
  float cw    = 1.30 + 0.55 * hf(ivec2(irow, 11));     // per-course tile width

  float xs   = p.x / cw + phase;
  float cidx = floor(xs);
  float pair = floor(cidx * 0.5);
  // Some adjacent pairs fuse into one double-width tessera: a 1:2 size rhythm
  // rather than a uniform grid, which is what stops it reading as graph paper.
  float merged = step(0.62, hf(ivec2(int(pair), irow)));
  float c0 = mix(cidx, pair * 2.0, merged);
  float wN = mix(1.0, 2.0, merged);

  float fx = (xs - c0) / wN;
  float fy = p.y - row;
  ivec2 id = ivec2(int(c0), irow);

  // Edge distances in field units. Corners are exactly 90 degrees.
  float dRight = (1.0 - fx) * cw * wN;
  float dLeft  = fx * cw * wN;
  float dTop   = 1.0 - fy;
  float dBot   = fy;
  float dEdge  = min(min(dLeft, dRight), min(dTop, dBot));

  /* --------------------------------------------- grain index per tessera */

  // Eight steps of 22.5 degrees. A machine indexes in steps; stepped angles
  // are the clearest "machined" tell available.
  float a  = floor(hf(id) * 8.0) * (PI / 8.0);
  vec2  tg = vec2(cos(a), sin(a));
  vec2  tb = vec2(-tg.y, tg.x);

  // Built from GLOBAL p, so only the angle changes at a seam and the phase
  // stays continuous: neighbours read as one milled part, not as a collage.
  float gu = dot(p, tg);
  float gv = dot(p, tb);

  /* ---------------------------------------------------------- the finish */

  // Brush: scratches long along the grain, thin across it. Evaluated on gv
  // only — that anisotropy is what "brushed" actually means, and 1-D noise is
  // a third the cost of 2-D.
  float slopeV = 0.0;

  vec2 n1 = vnoise(gv * 88.0, 3);
  float lod1 = smoothstep(0.55, 0.16, fw * 88.0);
  slopeV += n1.y * 88.0 * 0.000145 * lod1;

  if (u_quality > 0.5) {
    vec2 n2 = vnoise(gv * 215.0, 5);
    float lod2 = smoothstep(0.55, 0.16, fw * 215.0);
    slopeV += n2.y * 215.0 * 0.000062 * lod2;
  }

  // Scratches are not infinitely long: an envelope along the grain breaks them
  // into finite lanes.
  float env = 0.72 + 0.28 * vnoise(gu * 2.7, 9).x;
  slopeV *= env;

  // Hard cap across the grain. The token file's own rule for brushed surfaces
  // is "under 3% contrast — any more and it stops being a finish and becomes a
  // stripe pattern". Outside the specular lobe this holds; inside it, the same
  // slope modulates a tight lobe and therefore reads strongly.
  slopeV = clamp(slopeV, -0.017, 0.017);

  vec2 slope = tb * slopeV;

  // Mill scallops: the arc the cutter leaves. This is the difference between
  // "milled" and "sanded", and it is only ever visible inside the specular.
  if (u_quality > 0.5) {
    float sc = cos((gu - floor(gu / 0.34) * 0.34 - 0.17) * 18.5) * 0.0026;
    slope += tg * sc * smoothstep(0.5, 0.12, fw * 18.0);
  }

  /* ------------------------------------------------------- gouge lanes */

  // Straight lanes in SCREEN space: they cross tile boundaries and are the
  // evidence that this is one part with a history rather than a tiling.
  vec2 gouge = vec2(0.0);
  {
    vec2 n = vec2(0.99027, -0.13917); // 8 deg
    float d = abs(dot(s - vec2(-0.18, 0.06), n));
    gouge += n * (1.0 - smoothstep(0.0, 0.0065, d)) * 0.030;
  }
  {
    vec2 n = vec2(0.96126, 0.27564); // -14 deg
    float d = abs(dot(s - vec2(0.22, -0.13), n));
    gouge += n * (1.0 - smoothstep(0.0, 0.0042, d)) * 0.024;
  }
  if (u_quality > 0.5) {
    vec2 n = vec2(0.45399, -0.89101); // 63 deg
    float d = abs(dot(s - vec2(0.05, 0.20), n));
    gouge += n * (1.0 - smoothstep(0.0, 0.0035, d)) * 0.020;
  }
  slope += gouge;

  /* ------------------------------------------------------------- crown */

  // Linear, not sinusoidal: exactly one band exists, and it can never leave
  // the frame.
  float t = dot(s, CROWN_AXIS);
  slope += CROWN_AXIS * (Kc * t) + SET_TILT;

  // The plate's own form, without the finish or the bevels.
  vec2 macroSlope = CROWN_AXIS * (Kc * t) + SET_TILT + gouge;

  /* ----------------------------------------------------- seam chamfers */

  // Two CSS px, floored at 1.25 buffer px so the bevel survives the adaptive
  // resolution controller rather than dissolving into a blur.
  float chW = max(2.0 / S, 1.25 / (u_px * S));

  // Every tessera sits a few microns proud or shy of its neighbours, so the
  // lit lip and the dark lip are never the same width.
  float lift = (hf(id + ivec2(101, 57)) - 0.5) * 0.55 + 1.0;
  float ramp = 0.84 * lift; // tan(40 deg)

  vec2 chamfer = vec2(0.0);
  chamfer.x += (1.0 - smoothstep(0.0, chW, dRight)) * ramp;
  chamfer.x -= (1.0 - smoothstep(0.0, chW, dLeft)) * ramp;
  chamfer.y += (1.0 - smoothstep(0.0, chW, dTop)) * ramp;
  chamfer.y -= (1.0 - smoothstep(0.0, chW, dBot)) * ramp;
  slope += chamfer;

  /* ------------------------------------------------------------ normals */

  // Two normals, deliberately. The macro normal carries only the plate's own
  // form — the crown and the gouges — and drives diffuse. The micro normal
  // adds the bevels and the finish and drives specular alone.
  //
  // Collapsing them is the mistake that turns this into a grid of rectangles:
  // a 40-degree chamfer shaded diffusely outlines all four sides of every
  // tessera at once, and the lattice stops being a lit surface and becomes a
  // wireframe. Split, the seams are visible only where the light actually
  // catches them.
  vec3 Nmacro = normalize(vec3(-macroSlope.x, -macroSlope.y, 1.0));
  vec3 N = normalize(vec3(-slope.x, -slope.y, 1.0));

  /* ------------------------------------------------------------- light */

  // The pointer tilts the part. Nothing is attached to the cursor: no glow,
  // no spotlight, no radial falloff.
  vec2 ptr = u_pointer / max(1.0, length(u_pointer));
  vec2 tilt = ptr * mix(vec2(0.105, 0.075), vec2(0.140, 0.100), u_coarse);

  // The view direction is per-pixel, not orthographic, and that is what makes
  // this a lit object rather than a lookup table.
  //
  // With a constant V the half-vector H is constant across the whole frame, so
  // the only thing deciding whether a tessera is bright is its own grain angle
  // — every tile in the lobe fills uniformly and the plate reads as a chart of
  // random grey rectangles. Giving the eye a position makes H vary across the
  // surface, so the highlight becomes a locus that sweeps: tiles enter and
  // leave it by WHERE THEY ARE as well as by how they are brushed.
  vec3 P   = vec3(s * 2.0, 0.0);
  vec3 eye = vec3(0.0, 0.0, 1.9);

  vec3 L = tiltDir(L0, tilt);
  vec3 V = tiltDir(normalize(eye - P), tilt);
  vec3 H = normalize(L + V);

  float ndl = max(dot(N, L), 0.0);
  float ndv = max(dot(N, V), 0.0001);
  float ndh = max(dot(N, H), 0.0001);

  /* ------------------------------------------- anisotropic specular (Ward) */

  // Tangent frame on the surface, aligned to this tessera's grain.
  vec3 T3 = normalize(vec3(tg, dot(tg, slope)));
  vec3 B3 = normalize(cross(N, T3));
  T3 = cross(B3, N);

  // The anisotropy runs the way real brushed metal does, and the direction is
  // easy to get backwards: scratches lie ALONG the grain, so the surface
  // normals scatter ACROSS it. Roughness is therefore tight along the grain and
  // broad across it, and the highlight it produces is an elongated streak lying
  // PERPENDICULAR to the scratches.
  //
  // Inverted, the lobe is broad along the grain instead, an entire tessera sits
  // inside it, and the tile fills as a uniformly lighter rectangle — a lit
  // FIELD rather than a lit STREAK, which is the exact failure the brief warns
  // about. The fix is one swap and it is the difference between machined metal
  // and a grid of grey boxes.
  float ax = 0.021 * (1.0 + 2.4 * fw); // along the grain — the hairline
  float ab = 0.30;                     // across it — the streak's length

  float hu = dot(H, T3) / ax;
  float hv = dot(H, B3) / ab;
  float ex = -(hu * hu + hv * hv) / max(ndh * ndh, 0.0001);
  float spec = exp(ex) / (4.0 * PI * ax * ab * sqrt(max(ndl * ndv, 0.0001)));
  spec *= ndl;

  // The broad sheen, modelled the way a cylindrical crown actually behaves:
  // as a one-dimensional band, not a point lobe.
  //
  // A crown bends the plate along ONE axis, so it can only ever cancel the
  // component of the light lying along that axis; the perpendicular component
  // is always left over. Asking dot(Nmacro, H) for a tight highlight therefore
  // asks for an alignment that never occurs anywhere on the plate — the
  // residual pins it near zero and the band silently fails to exist.
  //
  // Comparing the two along the crown axis alone gives the band a guaranteed
  // location, a controllable width, and a linear sweep under tilt: the broad
  // diagonal sheen the hairline is meant to ride inside.
  float alongN = -dot(macroSlope, CROWN_AXIS);
  float alongH = dot(H.xy, CROWN_AXIS) / max(H.z, 0.001);
  float bandT  = (alongN - alongH) / 0.052;
  float sheen  = exp(-bandT * bandT) * 0.52;

  // A wide, weak term underneath, so the plate is never dead black and its
  // form stays legible well outside the band.
  sheen += exp(-bandT * bandT * 0.020) * 0.040;

  // Wrapped diffuse: graphite is not a mirror, and the wrap keeps the plate
  // from going pure black where it turns away.
  float diff = pow(clamp(dot(Nmacro, L) * 0.5 + 0.5, 0.0, 1.0), 1.9);

  /* --------------------------------------------------------------- AO */

  // Directional, and that is the whole point. An occlusion term applied evenly
  // to all four edges draws a box around every tessera, and a field of boxes is
  // the 2025 generic dark-grid look — the same failure as gradient-glass with a
  // longer commit history.
  //
  // A real milled step is lit on the lip facing the sun and dark on the lip
  // facing away, so the seam network is only ever half drawn. Which half
  // changes as the part tilts, which is most of why the lattice appears to
  // rotate under the light.
  vec2 chamN = -chamfer;
  float chamMag = length(chamN);
  vec2 sunXY = L.xy;
  float sunMag = length(sunXY);
  float facing = (chamMag > 1e-5 && sunMag > 1e-5)
      ? dot(chamN / chamMag, sunXY / sunMag)
      : 1.0;

  float nearEdge = 1.0 - smoothstep(0.0, chW * 2.4, dEdge);
  // Only the away-facing lips darken; the sun-facing ones are left to the
  // specular, which lights them where the light actually reaches.
  float shade = smoothstep(0.35, -0.85, facing);
  float ao = 1.0 - nearEdge * shade * 0.46;

  /* ------------------------------------------------- the legibility land */

  // A "land" is the unmachined face left proud on a milled part. Here it is
  // the h1's own rectangle: inside it the ceiling drops, so the brightest
  // pixel that can sit behind a glyph is lower still. The mask is evaluated at
  // the tile centre, so it steps on the lattice — there is no soft mask
  // anywhere in the frame.
  vec2 tileCentre = vec2((c0 + 0.5 * wN - phase) * cw, row + 0.5) * (u_px * S) + 0.5 * u_res;
  float inLand =
      step(u_land.x, tileCentre.x) * step(tileCentre.x, u_land.z) *
      step(u_land.y, tileCentre.y) * step(tileCentre.y, u_land.w);
  // Zero rect means "not measured yet": the global ceiling still holds.
  inLand *= step(1.0, u_land.z - u_land.x);

  /* ------------------------------------------------------------ compose */

  float revealGain = smoothstep(0.0, 1.0, u_reveal);

  vec3 col = mix(BG_SUBTLE, METAL_LO, diff * ao);
  float specGain = (spec * 0.62 + sheen) * revealGain * mix(1.0, 0.34, inLand);
  col = mix(col, METAL_HI, clamp(specGain, 0.0, 1.0));

  // CSS-pixel-locked static grain. The page's own body::before grain is
  // occluded by an opaque canvas, so the hero would otherwise read as a
  // conspicuously cleaner material than the sections above and below it.
  float g = hf(ivec2(floor(frag / max(u_px, 0.0001)))) - 0.5;
  col *= 1.0 + g * 0.34;

  // Dither before the clamp. #08080a -> #2e2e31 spans about 38 of 255 levels;
  // a smooth lobe falloff across a 1400px band contours visibly without it.
  float dither = fract(52.9829189 * fract(dot(frag, vec2(0.06711056, 0.00583715)))) - 0.5;
  col += dither * (1.0 / 255.0);

  // The hard ceiling, applied last — after grain and dither, so nothing can
  // slip above it.
  vec3 ceilCol = mix(METAL_HI, BG_INSET, inLand);
  col = min(col, ceilCol);

  fragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;
