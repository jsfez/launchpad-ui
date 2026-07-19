import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { argosScreenshot } from '@argos-ci/playwright';
import { type Page, test } from '@playwright/test';

type StoryIndex = {
	entries: Record<string, { id: string; title: string; name: string; type: string }>;
};

const indexPath = fileURLToPath(new URL('../storybook-static/index.json', import.meta.url));
const index: StoryIndex = JSON.parse(readFileSync(indexPath, 'utf-8'));

const only = process.env.ARGOS_ONLY?.split(',').map((s) => s.trim());

// The story's own Chromatic parameters, read at runtime from the built
// Storybook so the captured surface matches what Chromatic captures today.
// Reading them from the rendered story (rather than parsing the sources) means
// Storybook's own parameter inheritance applies: the `chromatic.modes` set
// globally in `.storybook/preview.tsx` reach every story, and a story that
// declares its own `modes` merges with them exactly as it does for Chromatic.
type ChromaticMode = Record<string, unknown> & { viewport?: number };

type ChromaticParams = {
	disableSnapshot?: boolean;
	delay?: number;
	viewports?: number[];
	ignoreSelectors?: string[];
	modes?: Record<string, ChromaticMode>;
};

// Loading indicators legitimately keep `aria-busy='true'` for as long as they
// are rendered, so waiting for it to clear never settles on their stories.
const LOADER = /load(ing|er)|skeleton|spinner|progress|busy/i;

// The default Storybook viewport, used whenever a story declares no
// `chromatic.viewports` and no mode carrying a viewport.
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;

const stories = Object.values(index.entries).filter(
	(entry) => entry.type === 'story' && (!only || only.includes(entry.id)),
);

// Wait for Storybook's own render cycle. Storybook 8+ exposes the active
// renders on `__STORYBOOK_PREVIEW__.storyRenders`; match the one for this
// story (fall back to the latest). Some stories render in a portal (modals,
// popovers, menus, toasts) and leave #storybook-root empty, so don't wait on
// the root.
const waitForStoryRendered = (page: Page, storyId: string) =>
	page.waitForFunction((id) => {
		const renders =
			(
				window as unknown as {
					__STORYBOOK_PREVIEW__?: { storyRenders?: { id?: string; phase?: string }[] };
				}
			).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
		const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
		return render?.phase === 'completed' || render?.phase === 'finished';
	}, storyId);

// Read the merged `parameters.chromatic` off the rendered story.
const readChromaticParams = (page: Page, storyId: string): Promise<ChromaticParams> =>
	page.evaluate((id) => {
		const renders =
			(
				window as unknown as {
					__STORYBOOK_PREVIEW__?: {
						storyRenders?: {
							id?: string;
							story?: { parameters?: { chromatic?: Record<string, unknown> } };
						}[];
					};
				}
			).__STORYBOOK_PREVIEW__?.storyRenders ?? [];
		const render = renders.find((r) => r.id === id) ?? renders[renders.length - 1];
		return (render?.story?.parameters?.chromatic ?? {}) as ChromaticParams;
	}, storyId);

// A single thing to capture: one Chromatic mode, at one viewport width.
type Capture = { suffix: string; width: number; globals: string };

// A `chromatic.modes` entry holds Storybook globals — here `theme`, matching
// the `withThemeByDataAttribute` decorator in `.storybook/preview.tsx` — except
// for `viewport`, which is a width rather than a global (`allModes.mobile` in
// `.storybook/modes.ts`). Split the two: globals go on the URL, a viewport
// becomes the width for that mode. `chromatic.viewports` are widths too, and
// Chromatic crosses them with the modes, so cross them here as well.
const buildCaptures = (params: ChromaticParams): Capture[] => {
	const widths = params.viewports?.length ? params.viewports : [DEFAULT_WIDTH];
	const modes = params.modes
		? Object.entries(params.modes).map(([name, mode]) => ({
				name,
				width: typeof mode.viewport === 'number' ? mode.viewport : undefined,
				globals: Object.entries(mode)
					.filter(([key]) => key !== 'viewport')
					.map(([key, value]) => `${key}:${value}`)
					.join(';'),
			}))
		: [{ name: '', width: undefined, globals: '' }];

	const captures: Capture[] = [];
	for (const mode of modes) {
		const modeWidths = mode.width === undefined ? widths : [mode.width];
		for (const width of modeWidths) {
			const parts = [mode.name, modeWidths.length > 1 ? `${width}px` : ''].filter(Boolean);
			captures.push({
				suffix: parts.length ? ` [${parts.join(' ')}]` : '',
				width,
				globals: mode.globals,
			});
		}
	}
	return captures;
};

for (const story of stories) {
	test(`${story.title} › ${story.name}`, async ({ page }) => {
		// Load once in the default mode to read the story's Chromatic parameters.
		// Booting the story iframe costs about two seconds, so this load is reused
		// for the first capture whenever that capture needs no other globals and
		// no other width.
		let loaded = { width: DEFAULT_WIDTH, globals: '' };
		await page.setViewportSize({ width: loaded.width, height: DEFAULT_HEIGHT });
		await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
		await waitForStoryRendered(page, story.id);
		const params = await readChromaticParams(page, story.id);

		// Honour the story's own Chromatic opt-out — in this repo, the deprecated
		// `Legacy/*` component stories.
		test.skip(params.disableSnapshot === true, 'story opts out of snapshots (chromatic parameter)');

		const isLoader = LOADER.test(`${story.title} ${story.name}`);

		for (const capture of buildCaptures(params)) {
			if (capture.width !== loaded.width || capture.globals !== loaded.globals) {
				await page.setViewportSize({ width: capture.width, height: DEFAULT_HEIGHT });
				const globals = capture.globals ? `&globals=${capture.globals}` : '';
				await page.goto(`/iframe.html?id=${story.id}&viewMode=story${globals}`);
				await waitForStoryRendered(page, story.id);
				loaded = { width: capture.width, globals: capture.globals };
			}

			// Honour the story's own `chromatic.delay`.
			if (params.delay) {
				await page.waitForTimeout(params.delay);
			}

			// The icon sprite is fetched and injected by `.storybook/preview.tsx`
			// after the story renders, so a capture can land before the icons
			// exist. Wait for the sprite to be in the document.
			await page
				.waitForFunction(() => document.getElementById('lp-icons-sprite') !== null, undefined, {
					timeout: 10_000,
				})
				.catch(() => {
					throw new Error('icon sprite was never injected');
				});

			// Components measure text before the webfonts finish loading and only
			// re-measure when a ResizeObserver fires. Wait for the fonts, then
			// nudge the viewport one pixel and back so size observers re-run with
			// the final font metrics.
			await page.evaluate(() => document.fonts.ready);
			await page.setViewportSize({ width: capture.width + 1, height: DEFAULT_HEIGHT });
			await page.setViewportSize({ width: capture.width, height: DEFAULT_HEIGHT });

			// Wait until the story markup holds still across two consecutive
			// samples, capped so endlessly looping stories still capture. This
			// catches JS-driven animation that neither `prefers-reduced-motion` nor
			// CSS animation stabilization covers.
			let previousMarkup = '';
			let stableSamples = 0;
			for (let i = 0; i < 40 && stableSamples < 2; i++) {
				const markup = await page.evaluate(() => document.body.innerHTML);
				stableSamples = markup === previousMarkup ? stableSamples + 1 : 0;
				previousMarkup = markup;
				if (stableSamples < 2) {
					await page.waitForTimeout(250);
				}
			}

			// Scrollable containers (overflowing tables, virtualized lists) may
			// settle on a non-deterministic offset: pin every scroll position.
			await page.evaluate(() => {
				for (const el of Array.from(document.querySelectorAll('*'))) {
					if (el.scrollLeft !== 0) {
						el.scrollLeft = 0;
					}
					if (el.scrollTop !== 0) {
						el.scrollTop = 0;
					}
				}
			});

			// SVG SMIL animations (`<animate>`) ignore `prefers-reduced-motion` and
			// aren't covered by Argos's animation stabilization, so a capture lands
			// at an arbitrary point of the timeline. Rewind them and pause.
			await page.evaluate(() => {
				for (const svg of Array.from(document.querySelectorAll('svg'))) {
					if (typeof svg.pauseAnimations !== 'function') {
						continue;
					}
					svg.setCurrentTime(0);
					svg.pauseAnimations();
				}
			});

			// Honour the story's own `chromatic.ignoreSelectors`: Argos ignores
			// elements carrying `data-visual-test="transparent"`.
			if (params.ignoreSelectors?.length) {
				await page.evaluate((selectors) => {
					for (const selector of selectors) {
						for (const el of Array.from(document.querySelectorAll(selector))) {
							el.setAttribute('data-visual-test', 'transparent');
						}
					}
				}, params.ignoreSelectors);
			}

			await argosScreenshot(page, `${story.id}${capture.suffix}`, {
				stabilize: { waitForAriaBusy: !isLoader },
			});
		}
	});
}
