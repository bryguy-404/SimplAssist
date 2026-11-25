'use client';

import { useState } from 'react';
import { HexColorInput, HexColorPicker } from 'react-colorful';
import { cn } from '@/lib/utils';

// The chat widget's header shows a small dot mascot whenever there is no logo
// to display. This field picks the dot's colour; the widget script chooses eye
// colours that read against it (see applyMascotColors in widget/embed.js).

/** White reads against any brand colour, so every widget starts with it. */
export const DEFAULT_MASCOT_COLOR = '#FFFFFF';

const MASCOT_COLORS = [
  { name: 'White', value: '#FFFFFF' },
  { name: 'Charcoal', value: '#1F2937' },
  { name: 'Yellow', value: '#FACC15' },
  { name: 'Orange', value: '#F97316' },
  { name: 'Pink', value: '#EC4899' },
  { name: 'Green', value: '#22C55E' },
  { name: 'Blue', value: '#3B82F6' },
  { name: 'Purple', value: '#8B5CF6' },
];

export function MascotColorField({ value, onChange, logoShowing }: {
  value: string;
  onChange: (color: string) => void;
  /** True when an uploaded logo is taking the dot's place. */
  logoShowing: boolean;
}) {
  const isPreset = MASCOT_COLORS.some((color) => color.value.toLowerCase() === value.toLowerCase());
  const [custom, setCustom] = useState(!isPreset);

  return (
    <div>
      <label className="block text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">Dot Color</label>
      <p className="mt-1 mb-2 text-sm text-stone-500 dark:text-[#bdbdbf]">
        {logoShowing
          ? 'Your logo is showing in the chat header. Without it, visitors see a friendly dot in this color.'
          : 'A friendly dot greets visitors in the chat header. Pick its color, or upload a logo above to use that instead.'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {MASCOT_COLORS.map((color) => (
          <button
            key={color.value}
            type="button"
            title={color.name}
            aria-label={`${color.name} dot`}
            aria-pressed={value.toLowerCase() === color.value.toLowerCase()}
            onClick={() => onChange(color.value)}
            className={cn(
              'h-8 w-8 rounded-full border-2 transition-transform hover:scale-110',
              value.toLowerCase() === color.value.toLowerCase()
                ? 'border-stone-900 dark:border-[#f5f5f5] scale-110'
                : 'border-[#e3dacc] dark:border-white/[0.20]'
            )}
            style={{ backgroundColor: color.value }}
          />
        ))}
        <button
          type="button"
          aria-expanded={custom}
          onClick={() => setCustom((open) => !open)}
          className="ml-1 text-sm font-medium text-stone-600 underline underline-offset-2 hover:text-stone-900 dark:text-[#bdbdbf] dark:hover:text-[#f5f5f5]"
        >
          {custom ? 'Hide custom color' : 'Custom color'}
        </button>
      </div>
      {custom && (
        <div className="mt-3 space-y-3">
          <HexColorPicker color={value} onChange={onChange} />
          <div className="flex items-center gap-3">
            <div
              className="h-9 w-9 rounded-lg border border-[#ece4d8] dark:border-white/[0.12] flex-shrink-0"
              style={{ backgroundColor: value }}
            />
            <div className="flex items-center gap-1 rounded-lg border border-[#e3dacc] bg-white dark:border-white/[0.12] dark:bg-white/[0.06] px-3 py-2">
              <span className="text-sm text-stone-400 dark:text-[#666]">#</span>
              <HexColorInput
                color={value}
                onChange={onChange}
                aria-label="Dot color hex value"
                className="w-20 bg-transparent text-sm text-stone-900 dark:text-[#f5f5f5] outline-none uppercase tracking-wider"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
