"use client";

import { useEffect, useRef } from "react";

/**
 * The WebGL harness for the hero.
 *
 * Deliberately separated from the shader: everything here is about the effect
 * not being a liability. A background that costs battery, blocks first paint,
 * janks a scroll or survives a lost GPU context as a black rectangle is worse
 * than no background at all. The picture is in `hero-shader.ts`; this is the
 * discipline around it.
 *
 * What it guarantees:
 *
 *   - the GL context is not even created until the section is on screen, so it
 *     costs nothing on a page the visitor never scrolls to;
 *   - nothing renders while the tab is hidden or the section is out of view;
 *   - the buffer is capped in DPR *and* in absolute pixels, because the shader
 *     costs per pixel and an ultrawide otherwise asks for five times a laptop's
 *     work;
 *   - under load it drops DETAIL before RESOLUTION — this design lives in
 *     hairlines and chamfers, and a soft upscale destroys them far more visibly
 *     than losing one noise octave does;
 *   - `prefers-reduced-motion` draws exactly one frame, and redraws it on
 *     resize, so the composition survives a rotation without going blank;
 *   - a lost context is rebuilt rather than left dead;
 *   - if WebGL2 is missing nothing appears, and the page is exactly what it was
 *     before this file existed.
 */

export interface HeroCanvasProps {
  fragmentSource: string;
  className?: string;
  /** The h1's rect in CSS px relative to the canvas, or null before measuring. */
  land?: { x: number; y: number; width: number; height: number } | null;
}

/** Full-screen triangle from gl_VertexID — no vertex buffer, no attributes. */
const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Beyond this the detail is invisible and the cost is pure waste. */
const MAX_DPR = 1.75;
/** Absolute ceiling: an ultrawide would otherwise ask for 5-11 Mpx. */
const MAX_PIXELS = 2_400_000;
/** Below this the chamfers and the hairline dissolve — the illusion dies. */
const MIN_SCALE = 0.7;

const SLOW_FRAME_MS = 26;
const FAST_FRAME_MS = 13;
/** After this long with no input, the plate goes back to drifting on its own. */
const INPUT_IDLE_MS = 2500;

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

export function HeroCanvas({ fragmentSource, className, land }: HeroCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read by the render loop without re-running the effect, so a re-measure of
  // the h1 does not tear down and rebuild the GL context.
  const landRef = useRef(land ?? null);
  useEffect(() => {
    landRef.current = land ?? null;
  }, [land]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const coarseQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(pointer: coarse)")
        : null;

    let reduceMotion = motionQuery?.matches ?? false;
    const coarse = coarseQuery?.matches ?? false;

    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let raf = 0;
    let disposed = false;
    let started = false;

    type Uniforms = {
      res: WebGLUniformLocation | null;
      pointer: WebGLUniformLocation | null;
      reveal: WebGLUniformLocation | null;
      land: WebGLUniformLocation | null;
      px: WebGLUniformLocation | null;
      quality: WebGLUniformLocation | null;
      coarse: WebGLUniformLocation | null;
    };
    let uniforms: Uniforms | null = null;

    /* ------------------------------------------------------------- build */

    function compile(ctx: WebGL2RenderingContext, type: number, source: string) {
      const shader = ctx.createShader(type);
      if (!shader) return null;
      ctx.shaderSource(shader, source);
      ctx.compileShader(shader);
      return shader;
    }

    function build(ctx: WebGL2RenderingContext): boolean {
      const vs = compile(ctx, ctx.VERTEX_SHADER, VERTEX_SOURCE);
      const fs = compile(ctx, ctx.FRAGMENT_SHADER, fragmentSource);
      if (!vs || !fs) return false;

      const created = ctx.createProgram();
      if (!created) return false;
      ctx.attachShader(created, vs);
      ctx.attachShader(created, fs);
      ctx.linkProgram(created);

      // Querying COMPILE_STATUS before linking forces the driver to finish
      // compiling synchronously on the main thread. Asking only after the link
      // — and only for the error path — lets it happen in parallel.
      if (!ctx.getProgramParameter(created, ctx.LINK_STATUS)) {
        if (process.env.NODE_ENV !== "production") {
          console.error(
            "hero shader failed:",
            ctx.getShaderInfoLog(vs) || ctx.getShaderInfoLog(fs) || ctx.getProgramInfoLog(created),
          );
        }
        ctx.deleteShader(vs);
        ctx.deleteShader(fs);
        ctx.deleteProgram(created);
        return false;
      }

      ctx.deleteShader(vs);
      ctx.deleteShader(fs);

      program = created;
      vao = ctx.createVertexArray();
      uniforms = {
        res: ctx.getUniformLocation(created, "u_res"),
        pointer: ctx.getUniformLocation(created, "u_pointer"),
        reveal: ctx.getUniformLocation(created, "u_reveal"),
        land: ctx.getUniformLocation(created, "u_land"),
        px: ctx.getUniformLocation(created, "u_px"),
        quality: ctx.getUniformLocation(created, "u_quality"),
        coarse: ctx.getUniformLocation(created, "u_coarse"),
      };
      return true;
    }

    /* ------------------------------------------------------------ sizing */

    let scale = 1;
    let quality = 1;
    let rect = canvas.getBoundingClientRect();

    function measure() {
      rect = canvas!.getBoundingClientRect();
    }

    function resize(ctx: WebGL2RenderingContext, force = false) {
      measure();
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);

      let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      // Absolute pixel ceiling, independent of DPR.
      const wanted = cssW * cssH * dpr * dpr * scale * scale;
      if (wanted > MAX_PIXELS) dpr *= Math.sqrt(MAX_PIXELS / wanted);

      const width = Math.max(1, Math.round(cssW * dpr * scale));
      const height = Math.max(1, Math.round(cssH * dpr * scale));
      if (!force && width === canvas!.width && height === canvas!.height) return;

      canvas!.width = width;
      canvas!.height = height;
      ctx.viewport(0, 0, width, height);
    }

    /* ------------------------------------------------------------ pointer */

    // Target is what the input says; current is where the plate actually is.
    // The gap, closed a fraction each frame, is the whole reason it feels like
    // a part with mass rather than something glued to the cursor.
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let scrollTilt = 0;
    let hasInput = false;
    let lastInputAt = 0;

    function markInput(now: number) {
      hasInput = true;
      lastInputAt = now;
    }

    function setTarget(clientX: number, clientY: number) {
      if (rect.width === 0 || rect.height === 0) return;
      const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -(((clientY - rect.top) / rect.height) * 2 - 1);
      targetX = Math.max(-1.6, Math.min(1.6, nx));
      targetY = Math.max(-1.6, Math.min(1.6, ny));
      markInput(performance.now());
    }

    function onPointerMove(event: PointerEvent) {
      setTarget(event.clientX, event.clientY);
    }

    function onPointerLeave() {
      targetX = 0;
      targetY = 0;
      hasInput = false;
    }

    /** Touch is a drag: damped and amplified, never tracked under the thumb. */
    function onTouchMove(event: TouchEvent) {
      const touch = event.touches[0];
      if (touch) setTarget(touch.clientX, touch.clientY);
    }

    /**
     * Tilt, where the device offers it.
     *
     * iOS 13+ gates this behind a permission prompt that needs a user gesture,
     * and asking for motion access to decorate a background would be an
     * indefensible trade. So this listens without asking: on Android and older
     * iOS the events simply arrive, and everywhere else scroll and drift carry
     * the effect instead.
     */
    function onOrientation(event: DeviceOrientationEvent) {
      if (event.gamma === null || event.beta === null) return;
      targetX = Math.max(-1, Math.min(1, event.gamma / 35));
      targetY = Math.max(-1, Math.min(1, (event.beta - 45) / 45));
      markInput(performance.now());
    }

    /**
     * Scroll, folded in on coarse pointers.
     *
     * This is the coupling most phone visitors will actually feel, because most
     * of them scroll past and never drag: the light walks down the plate as the
     * section leaves the viewport.
     */
    let scrollQueued = false;
    function onScroll() {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => {
        scrollQueued = false;
        const height = window.innerHeight || 1;
        const progress = Math.max(-1, Math.min(1, -rect.top / height));
        scrollTilt = progress * 0.55;
      });
    }

    /* ------------------------------------------------------- run / pause */

    let running = false;
    let visible = true;
    let onScreen = false;
    let startedAt = 0;
    let elapsed = 0;
    let lastFrame = 0;
    let slowFrames = 0;
    let fastFrames = 0;
    let reveal = 0;

    function draw() {
      if (!gl || !program || !uniforms) return;
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform2f(uniforms.res, canvas!.width, canvas!.height);
      gl.uniform2f(uniforms.pointer, currentX, currentY);
      gl.uniform1f(uniforms.reveal, reveal);
      gl.uniform1f(uniforms.quality, quality);
      gl.uniform1f(uniforms.coarse, coarse ? 1 : 0);

      const pxRatio = rect.width > 0 ? canvas!.width / rect.width : 1;
      gl.uniform1f(uniforms.px, pxRatio);

      // The h1's rect, converted to buffer px with y up.
      const l = landRef.current;
      if (l && l.width > 0 && l.height > 0) {
        const x0 = l.x * pxRatio;
        const x1 = (l.x + l.width) * pxRatio;
        const yTop = l.y * pxRatio;
        const yBottom = (l.y + l.height) * pxRatio;
        gl.uniform4f(uniforms.land, x0, canvas!.height - yBottom, x1, canvas!.height - yTop);
      } else {
        gl.uniform4f(uniforms.land, 0, 0, 0, 0);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }

    function frame(now: number) {
      if (disposed || !gl) return;

      if (startedAt === 0) startedAt = now;
      const dtMs = lastFrame === 0 ? 16 : Math.min(now - lastFrame, 64);
      lastFrame = now;
      elapsed = (now - startedAt) / 1000;

      /* --- adaptive: detail first, resolution only if that is not enough -- */

      if (dtMs > SLOW_FRAME_MS) {
        slowFrames += 1;
        fastFrames = 0;
      } else if (dtMs < FAST_FRAME_MS) {
        fastFrames += 1;
        slowFrames = 0;
      }

      if (slowFrames > 30) {
        if (quality > 0.5) {
          quality = 0;
        } else if (scale > MIN_SCALE) {
          scale = Math.max(MIN_SCALE, scale - 0.15);
          resize(gl, true);
        }
        slowFrames = 0;
      } else if (fastFrames > 240 && scale < 1) {
        scale = Math.min(1, scale + 0.15);
        fastFrames = 0;
        resize(gl, true);
      }

      /* --- damping ------------------------------------------------------ */

      const dt = dtMs / 1000;
      // Frame-rate independent smoothing: the same feel at 60Hz and 120Hz,
      // which a naive `x += (target - x) * 0.08` does not give.
      const k = 1 - Math.exp(-dt * 5.5);

      if (hasInput && now - lastInputAt > INPUT_IDLE_MS) hasInput = false;

      if (!hasInput) {
        // Nobody is driving. A slow figure-of-eight on coprime periods keeps
        // the plate alive without ever repeating visibly or demanding notice.
        targetX = Math.sin(elapsed * 0.21) * 0.42;
        targetY = Math.sin(elapsed * 0.147) * Math.cos(elapsed * 0.093) * 0.34;
      }

      currentX += (targetX - currentX) * k;
      currentY += (targetY + (coarse ? scrollTilt : 0) - currentY) * k;

      reveal = Math.min(1, reveal + dt * 0.9);

      draw();
      raf = requestAnimationFrame(frame);
    }

    function sync() {
      const shouldRun = visible && onScreen && !reduceMotion && !disposed && !!gl;
      if (shouldRun && !running) {
        running = true;
        lastFrame = 0;
        startedAt = 0;
        raf = requestAnimationFrame(frame);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    }

    /* --------------------------------------------------------- lazy start */

    function start() {
      if (started || disposed) return;
      started = true;

      gl = canvas!.getContext("webgl2", CONTEXT_ATTRS) as WebGL2RenderingContext | null;
      if (!gl) return;
      if (!build(gl)) {
        gl = null;
        return;
      }

      resize(gl, true);
      attachInput();

      if (reduceMotion) {
        reveal = 1;
        draw();
      } else {
        sync();
      }
    }

    let inputAttached = false;
    function attachInput() {
      if (inputAttached || reduceMotion) return;
      inputAttached = true;
      if (coarse) {
        window.addEventListener("touchmove", onTouchMove, { passive: true });
        window.addEventListener("deviceorientation", onOrientation, { passive: true });
        window.addEventListener("scroll", onScroll, { passive: true });
      } else {
        window.addEventListener("pointermove", onPointerMove, { passive: true });
        document.addEventListener("pointerleave", onPointerLeave, { passive: true });
      }
    }

    function detachInput() {
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      inputAttached = false;
    }

    /* ------------------------------------------------------- observation */

    const observer =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(
            (entries) => {
              onScreen = entries.some((entry) => entry.isIntersecting);
              // The context is not created until the section is actually
              // reachable, so a visitor who never scrolls here pays nothing.
              if (onScreen && !started) start();
              sync();
            },
            { threshold: 0, rootMargin: "120px" },
          )
        : null;

    if (observer) {
      observer.observe(canvas);
    } else {
      onScreen = true;
      start();
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            if (!gl) {
              measure();
              return;
            }
            resize(gl);
            // Under reduced motion nothing is looping, so a resize would
            // otherwise leave a freshly reallocated — and therefore blank —
            // buffer on screen for good.
            if (reduceMotion) draw();
          })
        : null;
    resizeObserver?.observe(canvas);

    function onVisibility() {
      visible = document.visibilityState === "visible";
      sync();
    }
    document.addEventListener("visibilitychange", onVisibility);

    function onMotionChange() {
      reduceMotion = motionQuery?.matches ?? false;
      if (reduceMotion) {
        detachInput();
        running = false;
        cancelAnimationFrame(raf);
        currentX = 0;
        currentY = 0;
        reveal = 1;
        draw();
      } else {
        attachInput();
        sync();
      }
    }
    motionQuery?.addEventListener?.("change", onMotionChange);

    /* -------------------------------------------------------- context loss */

    function onLost(event: Event) {
      event.preventDefault();
      running = false;
      cancelAnimationFrame(raf);
      program = null;
      vao = null;
      uniforms = null;
      gl = null;
      started = false;
    }

    function onRestored() {
      if (disposed) return;
      reveal = 0;
      start();
    }

    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);

    /* ------------------------------------------------------------ cleanup */

    return () => {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery?.removeEventListener?.("change", onMotionChange);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      detachInput();
      if (gl && program) gl.deleteProgram(program);
      if (gl && vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      uniforms = null;
      gl = null;
    };
  }, [fragmentSource]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      // Decoration must never be the reason a tap does nothing or a selection
      // will not start.
      style={{ pointerEvents: "none", display: "block" }}
    />
  );
}
