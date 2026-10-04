/**
 * Animated cursor-reactive background: springy particles, depth parallax and an
 * ambient glow. Plain 2D canvas, no dependency.
 */

export type ColorScheme = "deep" | "void" | "nebula" | "thermal";

export interface AbyssConfig {
  container: HTMLElement;
  colorScheme?: ColorScheme;
  intensity?: number;
  particleCount?: number;
  zIndex?: number;
}

interface ParticleColor {
  hue: number;
  saturation: number;
  lightness: number;
}

interface ColorPalette {
  bg: readonly string[];
  particles: readonly ParticleColor[];
  glow: string;
}

interface Particle {
  x: number;
  y: number;
  /** Anchor as a fraction of the surface, so resize can reproject instead of reseed. */
  ax: number;
  ay: number;
  radius: number;
  opacity: number;
  speed: number;
  angle: number;
  depth: number;
  hue: number;
}

interface ResolvedConfig {
  container: HTMLElement;
  colorScheme: ColorScheme;
  intensity: number;
  particleCount: number;
  zIndex: number;
}

const COLOR_SCHEMES: Record<ColorScheme, ColorPalette> = {
  deep: {
    bg: ["#030712", "#0c1a2e", "#112240", "#1a2a4a"],
    particles: [
      { hue: 195, saturation: 80, lightness: 45 },
      { hue: 220, saturation: 70, lightness: 35 },
      { hue: 180, saturation: 60, lightness: 50 },
    ],
    glow: "rgba(14, 165, 233, 0.15)",
  },
  void: {
    bg: ["#000000", "#050505", "#0a0a0a", "#121212"],
    particles: [
      { hue: 280, saturation: 60, lightness: 40 },
      { hue: 320, saturation: 50, lightness: 35 },
      { hue: 260, saturation: 70, lightness: 30 },
    ],
    glow: "rgba(168, 85, 247, 0.12)",
  },
  nebula: {
    bg: ["#0d061a", "#1a0b2e", "#2d1340", "#3d1a5a"],
    particles: [
      { hue: 290, saturation: 80, lightness: 55 },
      { hue: 340, saturation: 75, lightness: 50 },
      { hue: 200, saturation: 65, lightness: 45 },
    ],
    glow: "rgba(236, 72, 153, 0.18)",
  },
  thermal: {
    bg: ["#1a0505", "#2d0a0a", "#3d1212", "#4a1a1a"],
    particles: [
      { hue: 15, saturation: 90, lightness: 45 },
      { hue: 45, saturation: 85, lightness: 50 },
      { hue: 0, saturation: 70, lightness: 40 },
    ],
    glow: "rgba(249, 115, 22, 0.15)",
  },
};

const GLOW_SPRITE_SIZE = 64;
const CONNECTION_DISTANCE = 120;
/** Below this a link stroke is too faint to be worth a `stroke()` call. */
const MIN_STROKE_ALPHA = 0.004;
const SPRING_RATE = 1.2;
/** Caps integration steps so a backgrounded tab does not teleport everything. */
const MAX_DELTA_SECONDS = 1 / 30;

export class AbyssBackground {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly config: ResolvedConfig;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotionQuery: MediaQueryList;

  private particles: Particle[] = [];
  private animationId: number | null = null;
  private running = false;
  private lastTime = 0;
  private width = 0;
  private height = 0;
  private offsetLeft = 0;
  private offsetTop = 0;
  private dpr = 1;
  private bgGradient: CanvasGradient | null = null;
  private glowSprite: HTMLCanvasElement | null = null;
  /** Set once the constructor is done, so the first frame is not drawn twice. */
  private ready = false;
  private mouse = { x: 0, y: 0, isInside: false };

  constructor(config: AbyssConfig) {
    this.config = {
      container: config.container,
      colorScheme: config.colorScheme ?? "deep",
      intensity: config.intensity ?? 0.6,
      particleCount: config.particleCount ?? 120,
      zIndex: config.zIndex ?? 0,
    };

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = [
      'position: absolute',
      'inset: 0',
      'width: 100%',
      'height: 100%',
      `z-index: ${this.config.zIndex}`,
      // The canvas is decorative: it must never swallow the pointer, which is
      // also why the cursor is tracked on `window` instead of on it.
      'pointer-events: none',
      'touch-action: none',
    ].join('; ');
    this.canvas.setAttribute('aria-hidden', 'true');

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('AbyssBackground: 2D context unavailable.');
    this.ctx = ctx;

    const container = this.config.container;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.style.overflow = 'hidden';
    container.insertBefore(this.canvas, container.firstChild);

    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    window.addEventListener('mousemove', this.handleMouseMove, { passive: true });
    window.addEventListener('mouseleave', this.handleMouseLeave, { passive: true });
    window.addEventListener('blur', this.handleMouseLeave, { passive: true });
    window.addEventListener('scroll', this.syncContainerOffset, { passive: true });
    this.reducedMotionQuery.addEventListener('change', this.handleReducedMotionChange);

    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(container);

    this.resize();
    this.ready = true;
    this.start();
  }

  private start(): void {
    if (this.running) return;

    if (this.reducedMotionQuery.matches) {
      this.draw(0);
      return;
    }

    this.running = true;
    this.lastTime = 0;

    const animate = (time: number) => {
      const delta = this.lastTime === 0 ? 0 : Math.min((time - this.lastTime) / 1000, MAX_DELTA_SECONDS);
      this.lastTime = time;
      this.draw(delta);
      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  }

  private stop(): void {
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    this.running = false;
  }

  private handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    if (event.matches) {
      this.stop();
      this.draw(0);
    } else {
      this.start();
    }
  };

  private draw(deltaTime: number): void {
    const { width, height } = this;
    if (width === 0 || height === 0) return;

    const ctx = this.ctx;
    const intensity = this.config.intensity;

    const background = this.bgGradient ?? (this.bgGradient = this.buildBackgroundGradient());
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (intensity > 0 && this.mouse.isInside) this.drawAmbientGlow();

    for (const particle of this.particles) this.drawParticle(particle, deltaTime, intensity);

    if (intensity > 0.3) this.drawConnections(intensity);
  }

  private drawAmbientGlow(): void {
    const { ctx, width, height, dpr } = this;
    const palette = COLOR_SCHEMES[this.config.colorScheme];
    const radius = Math.max(width, height) * 0.6 * dpr;
    const cx = this.mouse.x * dpr;
    const cy = this.mouse.y * dpr;

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    glow.addColorStop(0, palette.glow);
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawParticle(particle: Particle, deltaTime: number, intensity: number): void {
    const { ctx, width, height, dpr } = this;
    const palette = COLOR_SCHEMES[this.config.colorScheme];

    let pushX = 0;
    let pushY = 0;

    if (intensity > 0 && this.mouse.isInside) {
      const dx = this.mouse.x - particle.x;
      const dy = this.mouse.y - particle.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const reach = Math.max(width, height) * 0.4;

      if (distance < reach && distance > 0) {
        const force = (1 - distance / reach) * intensity * particle.depth * 30;
        pushX = (dx / distance) * force;
        pushY = (dy / distance) * force;
      }
    }

    particle.angle += particle.speed * deltaTime * 0.5;
    const organicX = Math.cos(particle.angle) * 15 * particle.depth;
    const organicY = Math.sin(particle.angle * 0.7) * 10 * particle.depth;
    const springX = (particle.ax * width - particle.x) * SPRING_RATE;
    const springY = (particle.ay * height - particle.y) * SPRING_RATE;

    particle.x += (organicX + springX + pushX) * deltaTime;
    particle.y += (organicY + springY + pushY) * deltaTime;

    const alpha = particle.opacity * (0.5 + 0.5 * particle.depth);
    const radius = particle.radius * (0.8 + 0.4 * particle.depth) * dpr;
    const cx = particle.x * dpr;
    const cy = particle.y * dpr;

    const { saturation, lightness } = palette.particles[0];
    ctx.fillStyle = `hsla(${particle.hue}, ${saturation}%, ${lightness}%, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    if (particle.depth > 0.6) {
      const glowRadius = radius * 3;
      ctx.globalAlpha = Math.min(1, alpha * 0.3);
      ctx.drawImage(this.getGlowSprite(), cx - glowRadius, cy - glowRadius, glowRadius * 2, glowRadius * 2);
      ctx.globalAlpha = 1;
    }
  }

  private drawConnections(intensity: number): void {
    const { ctx, dpr } = this;
    const maxDistanceSq = CONNECTION_DISTANCE * CONNECTION_DISTANCE;
    const reach = Math.max(this.width, this.height) * 0.4;

    ctx.lineWidth = 0.5 * dpr;

    for (let i = 0; i < this.particles.length; i += 1) {
      const a = this.particles[i];
      for (let j = i + 1; j < this.particles.length; j += 1) {
        const b = this.particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (Math.abs(dx) > reach || Math.abs(dy) > reach) continue;

        const distanceSq = dx * dx + dy * dy;
        if (distanceSq >= maxDistanceSq) continue;

        const alpha = (1 - Math.sqrt(distanceSq) / CONNECTION_DISTANCE) * 0.02 * intensity;
        if (alpha < MIN_STROKE_ALPHA) continue;

        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x * dpr, a.y * dpr);
        ctx.lineTo(b.x * dpr, b.y * dpr);
        ctx.stroke();
      }
    }
  }

  private buildBackgroundGradient(): CanvasGradient {
    const palette = COLOR_SCHEMES[this.config.colorScheme];
    const gradient = this.ctx.createLinearGradient(0, 0, 0, this.canvas.height);
    palette.bg.forEach((color, index) => {
      gradient.addColorStop(index / (palette.bg.length - 1), color);
    });
    return gradient;
  }

  private getGlowSprite(): HTMLCanvasElement {
    if (this.glowSprite) return this.glowSprite;

    const size = GLOW_SPRITE_SIZE;
    const sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;

    const spriteCtx = sprite.getContext('2d');
    if (spriteCtx) {
      const { hue, saturation, lightness } = COLOR_SCHEMES[this.config.colorScheme].particles[0];
      const gradient = spriteCtx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, `hsla(${hue}, ${saturation}%, ${lightness}%, 1)`);
      gradient.addColorStop(1, `hsla(${hue}, ${saturation}%, ${lightness}%, 0)`);
      spriteCtx.fillStyle = gradient;
      spriteCtx.fillRect(0, 0, size, size);
    }

    this.glowSprite = sprite;
    return sprite;
  }

  private handleResize = (): void => {
    this.resize();
  };

  private syncContainerOffset = (): void => {
    const rect = this.config.container.getBoundingClientRect();
    this.offsetLeft = rect.left;
    this.offsetTop = rect.top;
  };

  private resize(): void {
    const rect = this.config.container.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width === 0 || height === 0) return;

    this.offsetLeft = rect.left;
    this.offsetTop = rect.top;

    // Re-read on every resize: moving to a display with another pixel density
    // does not reliably fire ResizeObserver again.
    this.dpr = window.devicePixelRatio || 1;

    const previousWidth = this.width;
    const previousHeight = this.height;

    this.width = width;
    this.height = height;

    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;

    this.bgGradient = this.buildBackgroundGradient();

    if (this.particles.length === 0) {
      this.seedParticles();
    } else if (previousWidth > 0 && previousHeight > 0) {
      const scaleX = width / previousWidth;
      const scaleY = height / previousHeight;
      for (const particle of this.particles) {
        particle.x *= scaleX;
        particle.y *= scaleY;
      }
    }

    if (this.ready && !this.running) this.draw(0);
  }

  private seedParticles(): void {
    const count = this.config.particleCount;
    const palette = COLOR_SCHEMES[this.config.colorScheme];
    const colors = palette.particles;

    // Grid plus jitter: even coverage, no clumps and no holes.
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    this.particles = [];
    for (let i = 0; i < count; i += 1) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const ax = (col + 0.5 + (Math.random() - 0.5) * 0.5) / cols;
      const ay = (row + 0.5 + (Math.random() - 0.5) * 0.5) / rows;
      const color = colors[Math.floor(Math.random() * colors.length)];

      this.particles.push({
        x: ax * this.width,
        y: ay * this.height,
        ax,
        ay,
        radius: Math.random() * 1.5 + 0.5,
        opacity: Math.random() * 0.4 + 0.1,
        speed: Math.random() * 0.3 + 0.05,
        angle: Math.random() * Math.PI * 2,
        depth: Math.random() * 0.8 + 0.2,
        hue: color.hue + (Math.random() - 0.5) * 20,
      });
    }
  }

  private handleMouseMove = (event: MouseEvent): void => {
    const x = event.clientX - this.offsetLeft;
    const y = event.clientY - this.offsetTop;
    this.mouse.x = x;
    this.mouse.y = y;
    this.mouse.isInside = x >= 0 && y >= 0 && x <= this.width && y <= this.height;
  };

  private handleMouseLeave = (): void => {
    this.mouse.isInside = false;
  };

  setColorScheme(scheme: ColorScheme): void {
    if (scheme === this.config.colorScheme) return;
    this.config.colorScheme = scheme;
    this.bgGradient = this.buildBackgroundGradient();
    this.glowSprite = null;
    if (!this.running) this.draw(0);
  }

  setIntensity(intensity: number): void {
    this.config.intensity = Math.max(0, Math.min(1, intensity));
    if (!this.running) this.draw(0);
  }

  setParticleCount(count: number): void {
    this.config.particleCount = Math.max(10, Math.min(500, Math.round(count)));
    this.particles = [];
    this.seedParticles();
    if (!this.running) this.draw(0);
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('mouseleave', this.handleMouseLeave);
    window.removeEventListener('blur', this.handleMouseLeave);
    window.removeEventListener('scroll', this.syncContainerOffset);
    this.reducedMotionQuery.removeEventListener('change', this.handleReducedMotionChange);
    this.particles = [];
    this.glowSprite = null;
    this.canvas.remove();
  }
}

export function createAbyssBackground(config: AbyssConfig): AbyssBackground {
  return new AbyssBackground(config);
}