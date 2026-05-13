const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

canvas.width  = 600;
canvas.height = 400;

const PARTICLE_COUNT  = 160;
const CONNECTION_DIST = 130;
const BASE_COLOR      = [96, 165, 250];  // #60a5fa
const DIM_COLOR       = [30, 64, 175];   // #1e40af

class Particle {
  constructor() { this.reset(true); }

  reset(initial) {
    this.x     = Math.random() * canvas.width;
    this.y     = initial ? Math.random() * canvas.height : (Math.random() < 0.5 ? -4 : canvas.height + 4);
    this.vx    = (Math.random() - 0.5) * 0.4;
    this.vy    = (Math.random() - 0.5) * 0.4;
    this.r     = Math.random() * 1.8 + 0.8;
    this.color = Math.random() > 0.4 ? BASE_COLOR : DIM_COLOR;
    this.alpha = Math.random() * 0.5 + 0.3;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < -10 || this.x > canvas.width + 10 ||
        this.y < -10 || this.y > canvas.height + 10) {
      this.reset(false);
    }
  }

  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${this.color[0]},${this.color[1]},${this.color[2]},${this.alpha})`;
    ctx.fill();
  }
}

const particles = Array.from({ length: PARTICLE_COUNT }, () => new Particle());

function drawConnections() {
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const a = particles[i], b = particles[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < CONNECTION_DIST) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = `rgba(96,165,250,${(1 - dist / CONNECTION_DIST) * 0.25})`;
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }
    }
  }
}

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawConnections();
  particles.forEach(p => { p.update(); p.draw(); });
  requestAnimationFrame(frame);
}

frame();

// Signal main process that the splash is rendered and ready
window.electronAPI.invoke('splash-ready');
