import { defineConfig } from '@playwright/test';

// Path is relative to this config file's directory (Playwright's default
// webServer cwd), i.e. `<repo>/argos` → `<repo>/storybook-static`. This is the
// same build Chromatic consumes (`pnpm storybook:build`).
const STORYBOOK_STATIC = '../storybook-static';

const PORT = Number(process.env.ARGOS_PORT ?? 6106);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
	testDir: '.',
	testMatch: 'stories.spec.ts',
	timeout: 120_000,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 4 : 6,
	fullyParallel: true,
	reporter:
		process.env.ARGOS_TOKEN || process.env.CI
			? [['list'], ['@argos-ci/playwright/reporter']]
			: 'list',
	use: {
		baseURL: BASE_URL,
		// Matches `prefersReducedMotion: 'reduce'` in `.storybook/preview.tsx`.
		contextOptions: { reducedMotion: 'reduce' },
		launchOptions: {
			// Subpixel (LCD) text antialiasing makes glyph edges vary between CI
			// runs; disable it so text renders deterministically.
			args: ['--disable-lcd-text', '--font-render-hinting=none'],
		},
	},
	webServer: {
		command: `npx http-server ${STORYBOOK_STATIC} --port ${PORT} --silent`,
		url: `${BASE_URL}/iframe.html`,
		reuseExistingServer: true,
		timeout: 60_000,
	},
});
