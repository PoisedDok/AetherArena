import type { Config } from 'tailwindcss';
import type { DefaultColors } from 'tailwindcss/types/generated/colors';

// Aether-inspired dark theme: greyish blacks with crystal glassmorphism
const themeDark = (colors: DefaultColors) => ({
  50: '#0a0a0a',     // Primary background (darker than original)
  100: '#121212',    // Secondary background
  200: '#1a1a1a',    // Tertiary background / borders
  300: '#262626',    // Hover states / elevated surfaces
});

// Aether-inspired light theme: clean whites with subtle tints
const themeLight = (colors: DefaultColors) => ({
  50: '#ffffff',     // Primary background
  100: '#f9fafb',    // Secondary background
  200: '#f3f4f6',    // Tertiary background / borders
  300: '#e5e7eb',    // Hover states
});

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      borderColor: ({ colors }) => {
        return {
          light: themeLight(colors),
          dark: themeDark(colors),
        };
      },
      colors: ({ colors }) => {
        const colorsDark = themeDark(colors);
        const colorsLight = themeLight(colors);

        return {
          dark: {
            primary: colorsDark[50],
            secondary: colorsDark[100],
            ...colorsDark,
          },
          light: {
            primary: colorsLight[50],
            secondary: colorsLight[100],
            ...colorsLight,
          },
        };
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
    require('@headlessui/tailwindcss')({ prefix: 'headless' }),
  ],
};
export default config;
