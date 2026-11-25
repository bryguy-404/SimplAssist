// Confetti for the analytics consent card's send-off.
//
// Drawn on a throwaway full-screen canvas so pieces can fly past the card and
// keep falling after it has gone. Each piece is thrown outward, slows through
// the air, then drifts down while it spins and flips like paper. The canvas
// removes itself once every piece has faded.

const COLORS = ["#ea580c", "#ff914d", "#fbbf24", "#fde68a", "#f43f5e", "#f472b6", "#a78bfa", "#38bdf8", "#34d399"];
const PIECES = 130;
const FRAME_MS = 1000 / 60;

type Shape = "paper" | "dot" | "streamer";

type Piece = {
  x: number; y: number;
  angle: number; speed: number; // the throw, which air drag wears down
  fall: number; drift: number; // steady sink and sideways lean
  sway: number; swaySpeed: number;
  rotation: number; spin: number;
  flip: number; flipSpeed: number;
  width: number; height: number;
  shape: Shape; color: string;
  age: number; life: number; // in 60fps frames
};

function between(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makePiece(x: number, y: number, index: number): Piece {
  // Most pieces fan upward; the rest go every direction so the burst is round.
  const upward = index % 4 !== 0;
  const pick = Math.random();
  const shape: Shape = pick < 0.55 ? "paper" : pick < 0.8 ? "dot" : "streamer";
  return {
    x, y,
    angle: upward ? -Math.PI / 2 + between(-1.15, 1.15) : between(0, Math.PI * 2),
    speed: upward ? between(9, 27) : between(5, 15),
    fall: between(2.1, 3.6),
    drift: between(-0.5, 0.5),
    sway: between(0, Math.PI * 2),
    swaySpeed: between(0.06, 0.13),
    rotation: between(0, Math.PI * 2),
    spin: between(-0.22, 0.22),
    flip: between(0, Math.PI * 2),
    flipSpeed: between(0.1, 0.28),
    width: shape === "streamer" ? 3 : shape === "dot" ? between(6, 9) : between(7, 12),
    height: shape === "streamer" ? between(12, 18) : shape === "dot" ? 0 : between(4, 7),
    shape,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    age: 0,
    life: between(95, 155),
  };
}

/** Bursts confetti from a point given in viewport coordinates. */
export function burstConfetti(x: number, y: number) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return;

  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = window.innerWidth;
  const height = window.innerHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed", inset: "0", width: "100%", height: "100%",
    pointerEvents: "none", zIndex: "90",
  });
  document.body.appendChild(canvas);
  context.scale(ratio, ratio);

  const pieces = Array.from({ length: PIECES }, (_, index) => makePiece(x, y, index));
  let flash = 0; // the pop ring's age, in frames
  let last = performance.now();

  function frame(now: number) {
    // Step in 60fps frames, capped so a stalled tab does not teleport pieces.
    const step = Math.min(now - last, 50) / FRAME_MS;
    last = now;
    context!.clearRect(0, 0, width, height);

    // A quick ring where the dot popped.
    flash += step;
    if (flash < 16) {
      const progress = flash / 16;
      context!.globalAlpha = (1 - progress) * 0.7;
      context!.strokeStyle = "#ff914d";
      context!.lineWidth = 4 * (1 - progress) + 1;
      context!.beginPath();
      context!.arc(x, y, 14 + progress * 46, 0, Math.PI * 2);
      context!.stroke();
    }

    let alive = 0;
    for (const piece of pieces) {
      piece.age += step;
      if (piece.age >= piece.life) continue;
      alive += 1;

      piece.x += (Math.cos(piece.angle) * piece.speed + piece.drift + Math.cos(piece.sway) * 0.9) * step;
      piece.y += (Math.sin(piece.angle) * piece.speed + piece.fall) * step;
      piece.speed *= Math.pow(0.91, step);
      piece.sway += piece.swaySpeed * step;
      piece.rotation += piece.spin * step;
      piece.flip += piece.flipSpeed * step;

      // Pieces flip like paper: the face narrows to an edge and the back is darker.
      const face = Math.cos(piece.flip);
      const remaining = 1 - piece.age / piece.life;
      context!.globalAlpha = Math.min(1, remaining / 0.28);
      context!.save();
      context!.translate(piece.x, piece.y);
      context!.rotate(piece.rotation);
      context!.scale(1, Math.max(0.12, Math.abs(face)));
      for (const fill of face < 0 ? [piece.color, "rgba(0, 0, 0, 0.2)"] : [piece.color]) {
        context!.fillStyle = fill;
        context!.beginPath();
        if (piece.shape === "dot") {
          context!.arc(0, 0, piece.width / 2, 0, Math.PI * 2);
        } else {
          context!.rect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
        }
        context!.fill();
      }
      context!.restore();
    }
    context!.globalAlpha = 1;

    if (alive > 0) window.requestAnimationFrame(frame);
    else canvas.remove();
  }

  window.requestAnimationFrame(frame);
}
