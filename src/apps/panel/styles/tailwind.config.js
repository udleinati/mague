// Build AOT do CSS do painel: substitui o compilador Tailwind em runtime
// (cdn.tailwindcss.com) por um app.css estatico, purgado, servido de static/.
// Correr com `deno task build:css` apos mudar classes nos templates.
//
// daisyUI continua igual (componentes + temas light/dim) - so deixa de ser
// compilado no browser de cada utilizador a cada navegacao.
import daisyui from "daisyui";

/** @type {import('tailwindcss').Config} */
export default {
  // Caminhos relativos ao cwd da task (a propria pasta styles/).
  content: ["../templates/**/*.vto"],

  // Cores semanticas aplicadas por interpolacao Vento (`bg-{{ color }}`,
  // `text-{{ color }}`) ou concatenacao em JS (`"text-" + color`) - o scanner nao
  // as ve. Origem: STATUS_COLOR (pathology) + mapas de status de tickets.
  // So o que e construido dinamicamente: literais com opacidade (gradientes do
  // kpi_card, bordas dos toasts) ja vem do content scan, fora da safelist.
  safelist: [
    { pattern: /^(bg|text|border)-(primary|secondary|accent|neutral|info|success|warning|error)$/ },
    { pattern: /^bg-(primary|secondary|accent|neutral|info|success|warning|error)\/(10|15)$/ },
    { pattern: /^(bg|text)-base-content\/40$/ },
  ],

  plugins: [daisyui],
  daisyui: { themes: ["light", "dim"], logs: false },
};
