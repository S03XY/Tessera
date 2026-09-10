"use client";

import { useEffect, useRef, useState } from "react";
import { HeroCanvas } from "@/components/hero-canvas";
import { HERO_FRAGMENT_SHADER } from "@/components/hero-shader";

/**
 * The hero plate: the canvas plus the one measurement it needs.
 *
 * A "land" on a milled part is the face left proud, unmachined. Here it is the
 * headline's own rectangle: inside it the shader lowers its brightness ceiling,
 * so the plate is quieter exactly where the type sits and every contrast ratio
 * in the section stays provable.
 *
 * The rect is measured from the DOM rather than guessed in GLSL, because the
 * h1 is `clamp(3rem, 9vw, 8.5rem)` — its size depends on the viewport, and its
 * height depends on which font is loaded. Archivo loads with `display: swap`,
 * so the first paint is a fallback face at a different size: measuring once at
 * mount would mill the land in the wrong place and leave it there. Hence the
 * re-measure on `document.fonts.ready`.
 */
export function HeroPlate() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [land, setLand] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let frame = 0;

    function measure() {
      cancelAnimationFrame(frame);
      // Coalesce: fonts.ready, a resize and a reflow can all land together.
      frame = requestAnimationFrame(() => {
        const heading = document.getElementById("statement-h1");
        const host = wrapRef.current;
        if (!heading || !host) return;

        const a = heading.getBoundingClientRect();
        const b = host.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) return;

        setLand((previous) => {
          const next = {
            x: a.left - b.left,
            y: a.top - b.top,
            width: a.width,
            height: a.height,
          };
          // Only re-render when it actually moved: this feeds a uniform, and a
          // sub-pixel jitter would re-render the tree on every scroll.
          if (
            previous &&
            Math.abs(previous.x - next.x) < 1 &&
            Math.abs(previous.y - next.y) < 1 &&
            Math.abs(previous.width - next.width) < 1 &&
            Math.abs(previous.height - next.height) < 1
          ) {
            return previous;
          }
          return next;
        });
      });
    }

    measure();

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(wrap);
    const heading = document.getElementById("statement-h1");
    if (heading) observer?.observe(heading);

    // The headline is set in Archivo with display:swap; until it lands the
    // measured rect belongs to the fallback face.
    document.fonts?.ready?.then(measure).catch(() => {});

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} aria-hidden="true" className="absolute inset-0 z-0 overflow-hidden">
      <HeroCanvas
        fragmentSource={HERO_FRAGMENT_SHADER}
        land={land}
        className="h-full w-full"
      />
    </div>
  );
}
