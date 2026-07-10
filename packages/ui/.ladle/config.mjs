/** @type {import('@ladle/react').UserConfig} */
export default {
  stories: 'src/**/*.stories.tsx',
  port: 61010,
  previewPort: 61011,
  addons: {
    // data-mode rides Ladle's own theme state; flavor is our custom control.
    theme: { enabled: true, defaultState: 'light' },
    width: { enabled: true, options: { desktop: 960 }, defaultState: 0 },
  },
};
